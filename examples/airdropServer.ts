/**
 * Authenticated airdrop server.
 *
 * Every request is mutually authenticated (BRC-103/104), so `req.auth.identityKey`
 * is the caller's verified identity key — not something the client typed. The
 * server, not the client, decides the amount, and each identity can claim once.
 *
 * Client side:
 *   const res = await new AuthFetch(wallet).fetch(`${url}/airdrop/claim`, { method: 'POST' })
 *   await acceptBrc29Payment(wallet, await res.json())
 */
import express, { type Express } from 'express'
import { createAuthMiddleware, type AuthRequest } from '@bsv/auth-express-middleware'
import type { WalletInterface } from '@bsv/sdk'
import { createBrc29Payment } from '../client/payments'

export interface AirdropOptions {
  satoshis: number
  /** Persist this in a database in production; in memory here. */
  claimed?: Set<string>
}

export function createAirdropApp (treasury: WalletInterface, opts: AirdropOptions): Express {
  const claimed = opts.claimed ?? new Set<string>()
  const app = express()
  app.use(express.json())
  app.use(createAuthMiddleware({ wallet: treasury }))

  app.post('/airdrop/claim', async (req, res) => {
    const identityKey = (req as AuthRequest).auth?.identityKey
    if (identityKey === undefined || identityKey === 'unknown') {
      res.status(401).json({ error: 'mutual authentication required' })
      return
    }
    if (claimed.has(identityKey)) {
      res.status(409).json({ error: 'already claimed' })
      return
    }
    claimed.add(identityKey) // reserve before spending, so parallel requests cannot double-claim
    try {
      const payment = await createBrc29Payment(treasury, identityKey, opts.satoshis, `Airdrop ${opts.satoshis} sats`)
      res.json(payment)
    } catch (e) {
      claimed.delete(identityKey)
      res.status(500).json({ error: String((e as Error).message) })
    }
  })
  return app
}
