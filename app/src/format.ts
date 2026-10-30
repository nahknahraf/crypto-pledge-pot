import { useEffect, useState } from 'react'

export const SATS_PER_BSV = 100_000_000
export const WOC_TX = 'https://whatsonchain.com/tx/'

export function formatSats (sats: number): string {
  if (Math.abs(sats) >= 1_000_000) return `${(sats / SATS_PER_BSV).toLocaleString(undefined, { maximumFractionDigits: 8 })} BSV`
  return `${sats.toLocaleString()} sats`
}

export function formatUsd (sats: number, usdPerBsv?: number): string | undefined {
  if (usdPerBsv === undefined) return undefined
  const usd = (sats / SATS_PER_BSV) * usdPerBsv
  if (usd === 0) return '$0'
  if (usd < 0.01) return `$${usd.toFixed(6)}`
  return usd.toLocaleString(undefined, { style: 'currency', currency: 'USD' })
}

export const short = (s: string, n = 6): string => (s.length > 2 * n + 1 ? `${s.slice(0, n)}…${s.slice(-n)}` : s)

export function timeLeft (deadline: number, now = Date.now() / 1000): string {
  const s = Math.floor(deadline - now)
  if (s <= 0) return 'ended'
  const d = Math.floor(s / 86_400)
  const h = Math.floor((s % 86_400) / 3_600)
  const m = Math.floor((s % 3_600) / 60)
  return d > 0 ? `${d}d ${h}h left` : h > 0 ? `${h}h ${m}m left` : `${m}m left`
}

export const dateTime = (unix: number): string => new Date(unix * 1000).toLocaleString()

let pricePromise: Promise<number | undefined> | undefined

/** BSV/USD from WhatsOnChain (cached per page load). Undefined if unreachable. */
export function useBsvPrice (): number | undefined {
  const [price, setPrice] = useState<number>()
  useEffect(() => {
    pricePromise ??= fetch('https://api.whatsonchain.com/v1/bsv/main/exchangerate')
      .then(async r => (r.ok ? Number((await r.json()).rate) : undefined))
      .catch(() => undefined)
    void pricePromise.then(p => { if (p !== undefined && Number.isFinite(p)) setPrice(p) })
  }, [])
  return price
}
