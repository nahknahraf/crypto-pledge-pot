/**
 * Offline demo only: simulated wallets for browser visitors.
 *
 * In `npm run demo` the chain is wallet-toolbox's mock chain, so a real
 * wallet's transactions could never land there. Instead each browser gets
 * its own funded mock-chain wallet, kept here on the demo server and reached
 * over `POST /api/demo-wallet/:session/:call` with the BRC-100 call's JSON
 * arguments (app/src/demoWallet.ts is the browser side). The browser then
 * runs the same client code against it as against BSV Desktop.
 *
 * Never mount this on a server with real money: whoever knows a session id
 * controls that wallet.
 */
import express, { type Router } from 'express'
import { stringifyBRC100, type WalletInterface } from '@bsv/sdk'

/** The BRC-100 calls the browser may make. */
export const DEMO_WALLET_CALLS = [
  'createAction', 'signAction', 'abortAction', 'listActions', 'internalizeAction', 'listOutputs', 'relinquishOutput',
  'getPublicKey', 'revealCounterpartyKeyLinkage', 'revealSpecificKeyLinkage', 'encrypt', 'decrypt', 'createHmac', 'verifyHmac',
  'createSignature', 'verifySignature', 'acquireCertificate', 'listCertificates', 'proveCertificate', 'relinquishCertificate',
  'discoverByIdentityKey', 'discoverByAttributes', 'isAuthenticated', 'waitForAuthentication', 'getHeight', 'getHeaderForHeight',
  'getNetwork', 'getVersion'
] as const

export function createDemoWalletRouter (newWallet: () => Promise<WalletInterface>, opts: { maxWallets?: number } = {}): Router {
  const maxWallets = opts.maxWallets ?? 50
  const wallets = new Map<string, Promise<WalletInterface>>()
  let queue: Promise<unknown> = Promise.resolve() // fund one wallet at a time (mock-chain funding races)
  const walletFor = (session: string): Promise<WalletInterface> => {
    let w = wallets.get(session)
    if (w === undefined) {
      if (wallets.size >= maxWallets) throw new Error('the demo has reached its maximum number of visitor wallets; restart `npm run demo`')
      w = queue.then(newWallet)
      queue = w.catch(() => {})
      wallets.set(session, w)
      w.catch(() => wallets.delete(session))
    }
    return w
  }

  const router = express.Router()
  router.use(express.json({ limit: '20mb' }))
  router.post('/:session/:call', async (req, res) => {
    const { session, call } = req.params
    try {
      if (!/^[0-9a-f]{32}$/.test(session)) throw new Error('bad demo wallet session')
      if (!(DEMO_WALLET_CALLS as readonly string[]).includes(call)) throw new Error(`unknown wallet call ${call}`)
      const wallet = await walletFor(session)
      const out = await (wallet as any)[call](req.body ?? {}, 'cryptopledgepot.demo')
      res.type('json').send(stringifyBRC100(out))
    } catch (e) {
      res.status(400).json({ error: (e as Error).message })
    }
  })
  return router
}
