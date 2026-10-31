/**
 * The routine agent's own API, for the user's "Giving routines" page. It
 * belongs to ONE user and listens on 127.0.0.1 only (agent/routineAgentMain.ts);
 * the app reaches it at /routine-agent through the LOCAL dev server. Never
 * expose it publicly.
 *
 *   GET  /api/routine-agent            identity key, balance, owner, recent activity, last round
 *   POST /api/routine-agent/fund       a BRC-29 top-up from the owner (the first funder becomes the owner)
 *   POST /api/routine-agent/withdraw   { satoshis } → a BRC-29 payment to the owner, for their wallet to accept
 *   POST /api/routine-agent/step       run one round now (instead of waiting for the timer)
 */
import express, { type Express } from 'express'
import type { ChainTracker, WalletInterface } from '@bsv/sdk'
import { acceptBrc29Payment, createBrc29Payment, type Brc29Payment } from '../client/payments'
import type { RoutineAgent, RoutineStepSummary } from './routineAgent'

export interface RoutineAgentHttpOptions {
  agent: RoutineAgent
  wallet: WalletInterface
  chainTracker?: ChainTracker
  lastStep: () => RoutineStepSummary | undefined
  runStep: () => Promise<RoutineStepSummary>
}

export function createRoutineAgentApp (o: RoutineAgentHttpOptions): Express {
  const app = express()
  app.use(express.json({ limit: '5mb' }))
  const wrap = (fn: (req: express.Request) => Promise<unknown>) => async (req: express.Request, res: express.Response) => {
    try { res.json(await fn(req)) } catch (e) { res.status(400).json({ error: (e as Error).message }) }
  }

  app.get('/api/routine-agent', wrap(async () => ({
    identityKey: (await o.wallet.getPublicKey({ identityKey: true })).publicKey,
    balance: await o.agent.deps.balance(),
    ownerIdentityKey: o.agent.state.ownerIdentityKey,
    activity: [...o.agent.state.activity].reverse().slice(0, 30),
    lastStep: o.lastStep() ?? null
  })))

  app.post('/api/routine-agent/fund', wrap(async (req) => {
    const p = req.body as Brc29Payment
    if (!Array.isArray(p?.tx) || typeof p.senderIdentityKey !== 'string') throw new Error('expected a BRC-29 payment')
    o.agent.claimOwner(p.senderIdentityKey) // before accepting: a stranger's top-up is refused, not absorbed
    await acceptBrc29Payment(o.wallet, p, o.chainTracker, 'Routine agent budget top-up')
    return { ok: true, balance: await o.agent.deps.balance() }
  }))

  app.post('/api/routine-agent/withdraw', wrap(async (req) => {
    const owner = o.agent.state.ownerIdentityKey
    if (owner === null) throw new Error('this agent has no owner yet (nobody has funded it)')
    const balance = await o.agent.deps.balance()
    const requested = req.body?.satoshis === 'all' ? balance - 500 : Number(req.body?.satoshis)
    if (!Number.isSafeInteger(requested) || requested < 1) throw new Error('nothing to withdraw')
    if (requested > balance - 200) throw new Error(`the agent has ${balance} sats; keep ~200 for the fee`)
    // Always to the owner: whoever calls this endpoint, the money can only go back to the identity that funded it.
    return await createBrc29Payment(o.wallet, owner, requested, 'Routine agent budget back to owner')
  }))

  app.post('/api/routine-agent/step', wrap(async () => await o.runStep()))
  return app
}
