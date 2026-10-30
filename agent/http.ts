/**
 * The agent's public window: status, spend ledger, and a top-up endpoint.
 *
 *   GET  /api/agent          who the agent is, its campaign, balance, totals, last action
 *   GET  /api/agent/ledger   every paid call (txid, sats, city, reason)
 *   POST /api/agent/fund     a BRC-29 payment (from the web app's "Top up" button)
 *                            that the agent verifies (SPV) and internalizes.
 *                            Only ever adds money, so it needs no auth.
 */
import express, { type Express } from 'express'
import type { ChainTracker, WalletInterface } from '@bsv/sdk'
import { acceptBrc29Payment, type Brc29Payment } from '../client/payments'
import type { AgentState, Ledger, Store } from './ledger'
import type { StepOutcome } from './agent'

export interface AgentHttpOptions {
  wallet: WalletInterface
  ledger: Ledger
  state: Store<AgentState>
  chainTracker?: ChainTracker
  mission: string
  spendable: () => Promise<number>
  lastOutcome: () => StepOutcome | undefined
}

export function createAgentApp (o: AgentHttpOptions): Express {
  const app = express()
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    if (req.method === 'OPTIONS') { res.sendStatus(204); return }
    next()
  })
  app.use(express.json({ limit: '5mb' }))

  app.get('/api/agent', async (_req, res) => {
    const { publicKey } = await o.wallet.getPublicKey({ identityKey: true })
    res.json({
      identityKey: publicKey,
      mission: o.mission,
      campaignId: o.state.load().campaignId ?? null,
      balance: await o.spendable(),
      spent: o.ledger.totals(),
      lastOutcome: o.lastOutcome() ?? null
    })
  })

  app.get('/api/agent/ledger', (_req, res) => { res.json(o.ledger.all()) })

  app.post('/api/agent/fund', async (req, res) => {
    const p = req.body as Brc29Payment
    if (!Array.isArray(p?.tx) || typeof p.senderIdentityKey !== 'string' || !Number.isSafeInteger(p.satoshis)) {
      res.status(400).json({ error: 'expected a BRC-29 payment' }); return
    }
    try {
      await acceptBrc29Payment(o.wallet, p, o.chainTracker, 'Agent fee float top-up')
      res.json({ ok: true, txid: p.txid, balance: await o.spendable() })
    } catch (e) {
      res.status(400).json({ error: (e as Error).message })
    }
  })
  return app
}
