/**
 * The liquidity agent as a small HTTP service, so it runs on its own and any
 * donor (or donor agent) can use it:
 *
 *   GET  /api/lp          who it is, which chain, its price and limits, its swaps
 *   POST /api/lp/fund     a BRC-29 payment topping up its sats inventory (npm run lp:fund)
 *   POST /api/lp/quote    { usdc, donorBsvKey }      → Quote
 *   POST /api/lp/lock     { quoteId, sourceHtlcId }  → BsvLock (it checks the source lock first)
 *   GET  /api/lp/swaps/:quoteId                      → { state, lock } (a lost reply, a recovered lock)
 *
 * The service holds no donor funds and asks for no keys. Everything it says,
 * the donor re-checks on chain (DonorSwap.verifyLock), so a lying service can
 * waste a donor's time but not take their money.
 */
import express, { type Request, type Response } from 'express'
import type { ChainTracker } from '@bsv/sdk'
import { acceptBrc29Payment, type Brc29Payment } from '../client/payments'
import type { LiquidityAgent } from './liquidityAgent'
import { assetOf, unitOf } from './usdcChain'

export interface LiquidityAppOptions {
  /** The agent's BSV identity key, published so anyone can top up its sats inventory (BRC-29). */
  identityKey?: string
  /** SPV check for top-ups (Arcade on mainnet). Without it, /api/lp/fund is not served. */
  chainTracker?: ChainTracker
}

export function createLiquidityApp (lp: LiquidityAgent, o: LiquidityAppOptions = {}): express.Express {
  const app = express()
  app.use(express.json({ limit: '16kb' }))
  const handle = (fn: (req: Request) => Promise<unknown>) => async (req: Request, res: Response): Promise<void> => {
    try { res.json(await fn(req)) } catch (e) { res.status(400).json({ error: (e as Error).message }) }
  }
  // Amounts are in whole units of the source asset (USDC, BTC). The *Usdc names are kept for existing clients.
  const unit = unitOf(lp.source)
  app.get('/api/lp', handle(async () => ({
    sourceChain: lp.source.name,
    bsvIdentityKey: o.identityKey ?? null,
    bsvSpendable: await lp.spendable(),
    asset: assetOf(lp.source),
    lpAddress: lp.address,
    satsPerUsdc: lp.config.satsPerUsdc,
    maxUsdc: lp.config.maxUsdc / unit,
    quoteValiditySeconds: lp.config.quoteValidity,
    minSourceWindowSeconds: lp.config.minSourceWindow,
    swaps: lp.all().map(s => ({ id: s.quote.id, state: s.state, usdc: s.quote.usdc / unit, sats: s.quote.sats, note: s.note }))
  })))
  app.get('/api/lp/swaps/:quoteId', handle(async req => {
    const lock = await lp.lockFor(String(req.params.quoteId))
    return { state: lp.state(String(req.params.quoteId)) ?? 'unknown', lock: lock ?? null }
  }))
  app.post('/api/lp/quote', handle(async req => await lp.quote(Number(req.body?.usdc), String(req.body?.donorBsvKey ?? ''))))
  // Top up the agent's sats inventory: a BRC-29 payment to its identity key, verified by SPV, then internalized.
  if (o.chainTracker !== undefined) {
    const tracker = o.chainTracker
    app.post('/api/lp/fund', handle(async req => {
      const p = req.body as Brc29Payment
      if (!Array.isArray(p?.tx) || typeof p.senderIdentityKey !== 'string' || !Number.isSafeInteger(p.satoshis)) throw new Error('expected a BRC-29 payment')
      await acceptBrc29Payment(lp.wallet, p, tracker, 'Liquidity agent inventory top-up')
      return { ok: true, txid: p.txid, spendable: await lp.spendable() }
    }))
  }
  app.post('/api/lp/request', handle(async req => ({ request: await lp.sourceRequest(String(req.body?.quoteId ?? ''), String(req.body?.hashlock ?? ''), Number(req.body?.refundAfter)) })))
  app.post('/api/lp/lock', handle(async req => await lp.acceptSourceLock(String(req.body?.quoteId ?? ''), String(req.body?.sourceHtlcId ?? ''))))
  return app
}
