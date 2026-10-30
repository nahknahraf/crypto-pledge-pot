/**
 * A small, independent paid data API that the agent buys from (BRC-121, HTTP 402).
 *
 * It sells air-quality readings per city at a fixed price per call. The data
 * is SYNTHETIC (deterministic from the city and date) and labelled as such:
 * the point of the demo is the payment rail, not the dataset. A real provider
 * would put its own data behind the same middleware unchanged.
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
  synthetic: true
}

/** Deterministic synthetic readings: same city and date → same numbers. */
export function syntheticReading (city: City, date = new Date().toISOString().slice(0, 10)): AirQualityReport {
  const h = Hash.sha256(`${city}|${date}`, 'utf8')
  const pm25 = 4 + (h[0] % 30)
  const pm10 = pm25 + 3 + (h[1] % 25)
  const no2 = 8 + (h[2] % 45)
  return { city, date, pm25, pm10, no2, aqi: Math.round(Math.max(pm25 * 2.1, pm10 * 1.0, no2 * 0.9)), synthetic: true }
}

export function createDataProviderApp (merchant: WalletInterface, priceSats: number): Express {
  const app = express()
  app.use((_req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Expose-Headers', '*')
    next()
  })
  app.get('/', (_req, res) => { res.json({ service: 'CryptoPledgePot demo air-quality data', priceSats, topics: CITIES, synthetic: true }) })
  app.use('/data/:city', createPaymentMiddleware({ wallet: merchant, calculatePrice: () => priceSats }))
  app.get('/data/:city', (req, res) => {
    const city = String(req.params.city).toLowerCase()
    if (!isCity(city)) { res.status(404).json({ error: 'unknown city' }); return }
    res.json({ ...syntheticReading(city), receiptId: Utils.toHex(Hash.sha256(JSON.stringify((req as any).payment ?? {}), 'utf8')).slice(0, 16) })
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
