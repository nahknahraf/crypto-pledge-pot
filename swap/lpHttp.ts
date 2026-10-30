/**
 * The liquidity agent as a small HTTP service, so it runs on its own and any
 * donor (or donor agent) can use it:
 *
 *   GET  /api/lp          who it is, which chain, its price and limits, its swaps
 *   POST /api/lp/quote    { usdc, donorBsvKey }      → Quote
 *   POST /api/lp/lock     { quoteId, sourceHtlcId }  → BsvLock (it checks the source lock first)
 *
 * The service holds no donor funds and asks for no keys. Everything it says,
 * the donor re-checks on chain (DonorSwap.verifyLock), so a lying service can
 * waste a donor's time but not take their money.
 */
import express, { type Request, type Response } from 'express'
import type { LiquidityAgent } from './liquidityAgent'
import { USDC } from './usdcChain'

export function createLiquidityApp (lp: LiquidityAgent): express.Express {
  const app = express()
  app.use(express.json({ limit: '16kb' }))
  const handle = (fn: (req: Request) => Promise<unknown>) => async (req: Request, res: Response): Promise<void> => {
    try { res.json(await fn(req)) } catch (e) { res.status(400).json({ error: (e as Error).message }) }
  }
  app.get('/api/lp', handle(async () => ({
    sourceChain: lp.source.name,
    lpAddress: lp.address,
    satsPerUsdc: lp.config.satsPerUsdc,
    maxUsdc: lp.config.maxUsdc / USDC,
    quoteValiditySeconds: lp.config.quoteValidity,
    minSourceWindowSeconds: lp.config.minSourceWindow,
    swaps: lp.all().map(s => ({ id: s.quote.id, state: s.state, usdc: s.quote.usdc / USDC, sats: s.quote.sats, note: s.note }))
  })))
  app.post('/api/lp/quote', handle(async req => await lp.quote(Number(req.body?.usdc), String(req.body?.donorBsvKey ?? ''))))
  app.post('/api/lp/lock', handle(async req => await lp.acceptSourceLock(String(req.body?.quoteId ?? ''), String(req.body?.sourceHtlcId ?? ''))))
  return app
}
