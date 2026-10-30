/**
 * Small fixed-window rate limiter, per client IP. No dependencies.
 *
 * Requests from the machine itself (loopback) are never limited: local tools,
 * the agent and tests. Behind a tunnel or reverse proxy, Express resolves the
 * real client IP from X-Forwarded-For because the server trusts loopback
 * proxies only (`trust proxy: 'loopback'`), so outside callers can't spoof it.
 */
import type { NextFunction, Request, Response } from 'express'

const isLoopback = (ip: string | undefined): boolean =>
  ip === undefined || ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1'

export function rateLimit (opts: { windowMs: number, max: number, what: string }) {
  const hits = new Map<string, { count: number, resetAt: number }>()
  return (req: Request, res: Response, next: NextFunction): void => {
    const ip = req.ip
    if (isLoopback(ip)) { next(); return }
    const now = Date.now()
    let h = hits.get(ip!)
    if (h === undefined || now >= h.resetAt) {
      h = { count: 0, resetAt: now + opts.windowMs }
      hits.set(ip!, h)
      if (hits.size > 10_000) for (const [k, v] of hits) if (now >= v.resetAt) hits.delete(k) // keep memory bounded
    }
    h.count++
    if (h.count > opts.max) {
      res.setHeader('Retry-After', String(Math.ceil((h.resetAt - now) / 1000)))
      res.status(429).json({ error: `too many ${opts.what}; try again in ${Math.ceil((h.resetAt - now) / 1000)} s` })
      return
    }
    next()
  }
}

/** Caps concurrent long-lived connections (SSE) per client IP. */
export function connectionCap (max: number) {
  const open = new Map<string, number>()
  return (req: Request, res: Response, next: NextFunction): void => {
    const ip = req.ip
    if (isLoopback(ip)) { next(); return }
    const n = open.get(ip!) ?? 0
    if (n >= max) { res.status(429).json({ error: 'too many open live-feed connections' }); return }
    open.set(ip!, n + 1)
    res.on('close', () => { const m = (open.get(ip!) ?? 1) - 1; if (m <= 0) open.delete(ip!); else open.set(ip!, m) })
    next()
  }
}
