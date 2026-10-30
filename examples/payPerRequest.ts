/**
 * Pay-per-request HTTP APIs (HTTP 402) with the two official protocols.
 *
 * BRC-105 (HTTP Service Monetization Framework) — mutually authenticated.
 *   Server: @bsv/auth-express-middleware + @bsv/payment-express-middleware
 *   Client: `new AuthFetch(wallet).fetch(url)` pays 402 challenges automatically.
 *   Use when the API already knows its callers by identity key.
 *
 * BRC-121 (Simple 402 Payments) — no authentication handshake.
 *   Server: createPaymentMiddleware from @bsv/402-pay/server
 *   Client: `create402Fetch({ wallet })(url)` pays automatically.
 *   Use for public content/APIs where anyone may pay per request.
 *
 * Both validate the BRC-29 payment with the merchant wallet (internalizeAction:
 * the sats land in the merchant's balance immediately) and refuse replays with
 * an atomic replay store. Use a shared, durable store when more than one
 * process serves the routes.
 */
import express, { type Express } from 'express'
import { createAuthMiddleware } from '@bsv/auth-express-middleware'
import { createPaymentMiddleware as createBrc105Middleware, type PaymentRequest } from '@bsv/payment-express-middleware'
import { createPaymentMiddleware as createBrc121Middleware } from '@bsv/402-pay/server'
import type { WalletInterface } from '@bsv/sdk'

/**
 * @bsv/402-pay 0.3.3's client passes the request origin WITH its scheme
 * ("https://api.example.com") as the BRC-100 originator; wallet-toolbox wallets
 * require a bare hostname ("api.example.com") and reject the call. Wrap a
 * wallet-toolbox wallet with this before giving it to create402Fetch /
 * constructPaymentHeaders.
 */
export function withHostOriginator (wallet: WalletInterface): WalletInterface {
  return new Proxy(wallet, {
    get (target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver)
      if (typeof value !== 'function') return value
      return (args: unknown, originator?: string) =>
        value.call(target, args, typeof originator === 'string' ? originator.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '') : originator)
    }
  })
}

/** BRC-105: price per path (0 = free). The receipt is in `req.payment`. */
export function createBrc105App (merchant: WalletInterface, prices: Record<string, number>): Express {
  const app = express()
  app.use(express.json())
  app.use(createAuthMiddleware({ wallet: merchant })) // 1) who is calling (BRC-103/104)
  app.use(createBrc105Middleware({ // 2) have they paid (BRC-105)
    wallet: merchant,
    calculateRequestPrice: req => prices[req.path] ?? 0
  }))
  app.get('/free', (req: PaymentRequest, res) => { res.json({ data: 'free data', receipt: req.payment }) })
  app.get('/premium', (req: PaymentRequest, res) => { res.json({ data: 'premium data', receipt: req.payment }) })
  return app
}

/** BRC-121: every /articles/:slug costs `satoshis`. */
export function createBrc121App (merchant: WalletInterface, satoshis: number): Express {
  const app = express()
  app.use('/articles/:slug', createBrc121Middleware({
    wallet: merchant,
    calculatePrice: () => satoshis
  }))
  app.get('/articles/:slug', (req, res) => {
    res.json({ article: req.params.slug, payment: (req as any).payment })
  })
  return app
}
