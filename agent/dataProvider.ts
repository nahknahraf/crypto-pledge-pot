/**
 * A small, independent paid data API that the agent buys from (BRC-121, HTTP 402).
 *
 * It sells air-quality readings per city at a fixed price per call.
 *  - source 'open-meteo' (production default): REAL current readings from
 *    Open-Meteo's free air-quality API (CAMS data), resold per call. If the
 *    source is unreachable the reading falls back to synthetic and says so.
 *  - source 'synthetic' (tests, offline demos): deterministic from city+date.
 * Every reading states its source; nothing synthetic is passed off as real.
 *
 * Runs as its own process with its own wallet, so every call is a real
 * transfer between two parties: `npm run data-provider`.
 */
import http from 'node:http'
import express, { type Express } from 'express'
import { createPaymentMiddleware } from '@bsv/402-pay/server'
import { Hash, Utils, type WalletInterface } from '@bsv/sdk'

/** Topics the provider sells. The agent's planner may only pick from these. */
export const CITIES = ['munich', 'berlin', 'paris', 'madrid', 'rome', 'vienna', 'zurich', 'amsterdam', 'warsaw', 'prague'] as const
export type City = typeof CITIES[number]
export const isCity = (s: unknown): s is City => typeof s === 'string' && (CITIES as readonly string[]).includes(s)

export interface AirQualityReport {
  city: City
  date: string
  pm25: number
  pm10: number
  no2: number
  aqi: number
  synthetic: boolean
  /** Where the numbers come from, e.g. "Open-Meteo (CAMS)" or "synthetic". */
  source: string
  observedAt?: string
}

/** City centres used for live lookups. */
export const CITY_COORDS: Record<City, [number, number]> = {
  munich: [48.14, 11.58], berlin: [52.52, 13.405], paris: [48.857, 2.352], madrid: [40.417, -3.704], rome: [41.903, 12.496],
  vienna: [48.208, 16.373], zurich: [47.377, 8.541], amsterdam: [52.37, 4.895], warsaw: [52.23, 21.012], prague: [50.075, 14.437]
}

/** A real, current reading from Open-Meteo's free air-quality API (no key needed). */
export async function liveReading (city: City, fetchImpl: typeof fetch = fetch): Promise<AirQualityReport> {
  const [lat, lon] = CITY_COORDS[city]
  const res = await fetchImpl(`https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat}&longitude=${lon}&current=pm10,pm2_5,nitrogen_dioxide,european_aqi`, { signal: AbortSignal.timeout(8_000) })
  if (!res.ok) throw new Error(`Open-Meteo HTTP ${res.status}`)
  const c = (await res.json()).current
  const num = (v: unknown): number => { const n = Number(v); if (!Number.isFinite(n)) throw new Error('Open-Meteo returned an incomplete reading'); return Math.round(n) }
  return { city, date: String(c.time).slice(0, 10), pm25: num(c.pm2_5), pm10: num(c.pm10), no2: num(c.nitrogen_dioxide), aqi: num(c.european_aqi), synthetic: false, source: 'Open-Meteo (CAMS)', observedAt: String(c.time) }
}

/** Deterministic synthetic readings: same city and date → same numbers. */
export function syntheticReading (city: City, date = new Date().toISOString().slice(0, 10)): AirQualityReport {
  const h = Hash.sha256(`${city}|${date}`, 'utf8')
  const pm25 = 4 + (h[0] % 30)
  const pm10 = pm25 + 3 + (h[1] % 25)
  const no2 = 8 + (h[2] % 45)
  return { city, date, pm25, pm10, no2, aqi: Math.round(Math.max(pm25 * 2.1, pm10 * 1.0, no2 * 0.9)), synthetic: true, source: 'synthetic' }
}

/**
 * @param premium  cities sold at a different price, e.g. { zurich: 500 } (the demo
 *                 uses this to show the agent refusing to overpay). The payment
 *                 middleware only sees the path after the mount point, so each
 *                 premium city gets its own middleware and the generic one skips it.
 */
export interface DataSourceOptions { source?: 'open-meteo' | 'synthetic', fetchImpl?: typeof fetch }

export function createDataProviderApp (merchant: WalletInterface, priceSats: number, premium: Partial<Record<City, number>> = {}, data: DataSourceOptions = {}): Express {
  const source = data.source ?? 'synthetic'
  const app = express()
  app.use((_req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Expose-Headers', '*')
    next()
  })
  app.get('/', (_req, res) => { res.json({ service: 'CryptoPledgePot air-quality data', priceSats, premium, topics: CITIES, source: source === 'open-meteo' ? 'Open-Meteo (CAMS), resold per call' : 'synthetic' }) })
  for (const [city, price] of Object.entries(premium)) {
    app.use(`/data/${city}`, createPaymentMiddleware({ wallet: merchant, calculatePrice: () => price }))
  }
  const standard = createPaymentMiddleware({ wallet: merchant, calculatePrice: () => priceSats })
  app.use('/data/:city', (req, res, next) => {
    if (String(req.params.city).toLowerCase() in premium) { next(); return }
    void standard(req, res, next)
  })
  app.get('/data/:city', async (req, res) => {
    const city = String(req.params.city).toLowerCase()
    if (!isCity(city)) { res.status(404).json({ error: 'unknown city' }); return }
    let reading: AirQualityReport
    if (source === 'open-meteo') {
      try { reading = await liveReading(city, data.fetchImpl) } catch (e) {
        reading = { ...syntheticReading(city), source: `synthetic (live source unavailable: ${(e as Error).message})` }
      }
    } else reading = syntheticReading(city)
    res.json({ ...reading, receiptId: Utils.toHex(Hash.sha256(JSON.stringify((req as any).payment ?? {}), 'utf8')).slice(0, 16) })
  })
  return app
}

/**
 * BRC-121 carries the payment as a BEEF in a request header, and that BEEF
 * includes every unconfirmed ancestor of the payer's coins. An agent paying at
 * 0-conf right after a milestone release spends change from a transaction with
 * several ~3 KB escrow inputs: we measured a 35 KB header, well over Node's
 * 16 KB default (→ HTTP 431). Serve paid routes with a larger header limit; a
 * reverse proxy in front needs the same (e.g. nginx large_client_header_buffers).
 */
export const PAID_HEADER_LIMIT = 1024 * 1024

export function serveDataProvider (app: Express, port: number, host?: string): Promise<http.Server> {
  const server = http.createServer({ maxHeaderSize: PAID_HEADER_LIMIT }, app)
  return new Promise(resolve => { server.listen(port, host, () => resolve(server)) })
}
