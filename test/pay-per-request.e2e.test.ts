/**
 * Pay-per-request APIs (HTTP 402), end to end with real wallet-toolbox wallets
 * on the mock chain: the client pays automatically, the merchant's balance
 * grows at once, and a replayed payment is refused.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import { AuthFetch, P2PKH, PublicKey, Random, Utils } from '@bsv/sdk'
import { constructPaymentHeaders, create402Fetch } from '@bsv/402-pay/client'
import type { Wallet } from '@bsv/wallet-toolbox'
import { createBrc105App, createBrc121App, withHostOriginator } from '../examples/payPerRequest'
import { createMockChain, type MockChain } from './helpers/mockchain'

let chain: MockChain
const spendableSats = async (w: Wallet): Promise<number> =>
  (await w.listOutputs({ basket: 'default', limit: 1000 })).outputs.filter(o => o.spendable).reduce((s, o) => s + o.satoshis, 0)
const listen = async (app: any, port: number): Promise<Server> => await new Promise(resolve => { const s = app.listen(port, () => resolve(s)) })

beforeAll(async () => { chain = await createMockChain() })
afterAll(async () => { await chain?.close() })

describe('BRC-105: authenticated pay-per-request (AuthFetch pays automatically)', () => {
  let merchant: Wallet, alice: Wallet, server: Server
  const url = 'http://localhost:18093'

  beforeAll(async () => {
    ;[merchant, alice] = await Promise.all([chain.makeWallet(), chain.makeWallet()])
    await chain.fund(alice)
    server = await listen(createBrc105App(merchant, { '/premium': 500 }), 18093)
  })
  afterAll(async () => { await new Promise(resolve => server?.close(resolve)) })

  it('serves a free route without payment', async () => {
    const res = await new AuthFetch(alice).fetch(`${url}/free`)
    expect(res.status).toBe(200)
    expect((await res.json()).receipt).toMatchObject({ satoshisPaid: 0 })
  })

  it('answers 402, the client pays, and the merchant is credited at once', async () => {
    const before = await spendableSats(merchant)
    const res = await new AuthFetch(alice).fetch(`${url}/premium`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toBe('premium data')
    expect(body.receipt).toMatchObject({ accepted: true, satoshisPaid: 500 })
    expect(await spendableSats(merchant)).toBe(before + 500)
  })

  it('refuses a replayed payment (409)', async () => {
    // Get a challenge without letting AuthFetch pay it.
    const probe = new AuthFetch(alice)
    ;(probe as any).handlePaymentAndRetry = async (_u: string, _c: unknown, r: Response) => r
    const challenge = await probe.fetch(`${url}/premium`)
    expect(challenge.status).toBe(402)
    const derivationPrefix = challenge.headers.get('x-bsv-payment-derivation-prefix')!
    const serverKey = challenge.headers.get('x-bsv-auth-identity-key')!
    // Pay it by hand, exactly as AuthFetch does (BRC-29 output 0 to the server).
    const derivationSuffix = Utils.toBase64(Random(32))
    const { publicKey } = await alice.getPublicKey({ protocolID: [2, '3241645161d8'], keyID: `${derivationPrefix} ${derivationSuffix}`, counterparty: serverKey })
    const created = await alice.createAction({
      description: 'Pay for a premium request',
      outputs: [{ satoshis: 500, lockingScript: new P2PKH().lock(PublicKey.fromString(publicKey).toAddress()).toHex(), outputDescription: 'HTTP request payment' }],
      options: { randomizeOutputs: false }
    })
    const header = JSON.stringify({ derivationPrefix, derivationSuffix, transaction: Utils.toBase64(Array.from(created.tx!)) })
    const client = new AuthFetch(alice)
    const first = await client.fetch(`${url}/premium`, { headers: { 'x-bsv-payment': header } })
    expect(first.status).toBe(200)
    const replay = await client.fetch(`${url}/premium`, { headers: { 'x-bsv-payment': header } })
    expect(replay.status).toBe(409)
  })
})

describe('BRC-121: simple 402 payments (no auth handshake)', () => {
  let merchant: Wallet, bob: Wallet, server: Server
  const url = 'http://localhost:18094'

  beforeAll(async () => {
    ;[merchant, bob] = await Promise.all([chain.makeWallet(), chain.makeWallet()])
    await chain.fund(bob)
    server = await listen(createBrc121App(merchant, 100), 18094)
  })
  afterAll(async () => { await new Promise(resolve => server?.close(resolve)) })

  it('challenges an unpaid request with 402 and the price', async () => {
    const res = await fetch(`${url}/articles/hello`)
    expect(res.status).toBe(402)
    expect(res.headers.get('x-bsv-sats')).toBe('100')
    expect(res.headers.get('x-bsv-server')).toBe(merchant.identityKey)
  })

  it('create402Fetch pays automatically; the merchant is credited', async () => {
    const before = await spendableSats(merchant)
    const res = await create402Fetch({ wallet: withHostOriginator(bob) })(`${url}/articles/hello`)
    expect(res.status).toBe(200)
    expect((await res.json()).article).toBe('hello')
    expect(await spendableSats(merchant)).toBe(before + 100)
  })

  it('refuses the same payment headers twice (fresh 402)', async () => {
    const headers = await constructPaymentHeaders(withHostOriginator(bob), `${url}/articles/again`, 100, merchant.identityKey)
    const first = await fetch(`${url}/articles/again`, { headers: headers as unknown as Record<string, string> })
    expect(first.status).toBe(200)
    const replay = await fetch(`${url}/articles/again`, { headers: headers as unknown as Record<string, string> })
    expect(replay.status).toBe(402)
  })
})
