/**
 * The donor agent's own API, for the donor's web page. It belongs to ONE
 * donor and listens on 127.0.0.1 only (donor-agent/main.ts); never expose it
 * publicly.
 *
 *   GET  /api/donor                   mode, terms, budget used/reserved/left, wallet (autopilot)
 *   GET  /api/donor/memos             every decision, newest first
 *   POST /api/donor/memos/:id/approve { pledgeId }: co-pilot, after the donor paid from their wallet
 *   POST /api/donor/memos/:id/decline co-pilot
 *   POST /api/donor/fund              autopilot: a BRC-29 budget top-up into the agent's wallet
 *   POST /api/donor/step              run one round now (instead of waiting for the timer)
 */
import express, { type Express } from 'express'
import type { ChainTracker, WalletInterface } from '@bsv/sdk'
import { acceptBrc29Payment, type Brc29Payment } from '../client/payments'
import type { DonorAgent, StepSummary } from './donorAgent'

export interface DonorHttpOptions {
  agent: DonorAgent
  /** Autopilot: the agent's budget wallet. */
  wallet?: WalletInterface
  chainTracker?: ChainTracker
  spendable?: () => Promise<number>
  lastStep: () => StepSummary | undefined
  runStep: () => Promise<StepSummary>
}

export function createDonorApp (o: DonorHttpOptions): Express {
  const app = express()
  app.use(express.json({ limit: '5mb' }))
  const wrap = (fn: (req: express.Request) => Promise<unknown>) => async (req: express.Request, res: express.Response) => {
    try { res.json(await fn(req)) } catch (e) { res.status(400).json({ error: (e as Error).message }) }
  }

  app.get('/api/donor', wrap(async () => {
    const m = o.agent.mandate
    const memos = o.agent.deps.memos.all()
    const executed = memos.filter(x => x.kind === 'pledge' && x.status === 'executed').reduce((s, x) => s + (x.amount ?? 0), 0)
    const reserved = memos.filter(x => x.kind === 'pledge' && x.status === 'proposed').reduce((s, x) => s + (x.amount ?? 0), 0)
    const reclaimed = memos.filter(x => x.kind === 'refund' && x.status === 'executed').reduce((s, x) => s + (x.amount ?? 0), 0)
    return {
      name: m.name,
      mode: m.mode,
      interests: m.interests,
      keywords: m.keywords,
      budget: { ...m.budget, pledged: executed, reserved, left: m.budget.totalSats - executed - reserved, reclaimed },
      requirements: m.requirements,
      scoreThreshold: m.scoreThreshold,
      donorIdentityKey: m.donorIdentityKey ?? null,
      wallet: o.wallet !== undefined
        ? { identityKey: (await o.wallet.getPublicKey({ identityKey: true })).publicKey, balance: await o.spendable?.() ?? null }
        : null,
      brain: o.agent.deps.brain.name,
      lastStep: o.lastStep() ?? null,
      counts: {
        proposals: memos.filter(x => x.status === 'proposed').length,
        pledges: memos.filter(x => x.kind === 'pledge' && x.status === 'executed').length,
        skipped: memos.filter(x => x.kind === 'skip').length,
        votes: memos.filter(x => x.kind === 'vote' && x.status === 'executed').length,
        refunds: memos.filter(x => x.kind === 'refund' && x.status === 'executed').length
      }
    }
  }))

  app.get('/api/donor/memos', wrap(async () => [...o.agent.deps.memos.all()].reverse()))

  app.post('/api/donor/memos/:id/approve', wrap(async (req) => {
    const pledgeId = String(req.body?.pledgeId ?? '')
    if (!/^[0-9a-f]{64}\.\d+$/.test(pledgeId)) throw new Error('pledgeId must be <txid>.<vout>')
    return await o.agent.approve(String(req.params.id), pledgeId)
  }))

  app.post('/api/donor/memos/:id/decline', wrap(async (req) => o.agent.decline(String(req.params.id))))

  app.post('/api/donor/step', wrap(async () => await o.runStep()))

  app.post('/api/donor/fund', wrap(async (req) => {
    if (o.wallet === undefined) throw new Error('only an autopilot agent has a budget wallet; in co-pilot you pay from your own wallet')
    const p = req.body as Brc29Payment
    if (!Array.isArray(p?.tx) || typeof p.senderIdentityKey !== 'string') throw new Error('expected a BRC-29 payment')
    await acceptBrc29Payment(o.wallet, p, o.chainTracker, 'Donor agent budget top-up')
    return { ok: true, balance: await o.spendable?.() ?? null }
  }))
  return app
}
