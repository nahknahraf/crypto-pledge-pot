/**
 * Instant payments, NFTs and an authenticated airdrop — end to end, offline,
 * with real wallet-toolbox wallets on the mock chain. No block is mined during
 * these flows: everything below happens at 0-conf.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import { AuthFetch, Transaction } from '@bsv/sdk'
import type { Wallet } from '@bsv/wallet-toolbox'
import { acceptBrc29Payment, createBrc29Payment, type Brc29Payment } from '../client/payments'
import { OrdinalKit } from '../client/ordinals'
import { createAirdropApp } from '../examples/airdropServer'
import { createMockChain, type MockChain } from './helpers/mockchain'

let chain: MockChain
const isMined = async (txid: string): Promise<boolean> =>
  (await (chain.services as any).storage.getTransaction(txid))?.blockHeight != null

const spendableSats = async (w: Wallet): Promise<number> =>
  (await w.listOutputs({ basket: 'default', limit: 1000 })).outputs.filter(o => o.spendable).reduce((s, o) => s + o.satoshis, 0)

beforeAll(async () => { chain = await createMockChain() })
afterAll(async () => { await chain?.close() })

describe('instant BRC-29 payments (no block confirmation)', () => {
  let alice: Wallet, bob: Wallet, carol: Wallet, mallory: Wallet
  let payment: Brc29Payment

  it('Alice pays Bob; Bob verifies SPV and internalizes', async () => {
    ;[alice, bob, carol, mallory] = await Promise.all([chain.makeWallet(), chain.makeWallet(), chain.makeWallet(), chain.makeWallet()])
    await chain.fund(alice)
    payment = await createBrc29Payment(alice, bob.identityKey, 50_000)
    expect(await isMined(payment.txid)).toBe(false)
    await acceptBrc29Payment(bob, payment, chain.chainTracker)
    expect(await spendableSats(bob)).toBe(50_000)
  })

  it('Bob spends the received sats immediately, before any block is mined', async () => {
    const onward = await createBrc29Payment(bob, carol.identityKey, 10_000)
    expect(Transaction.fromAtomicBEEF(onward.tx).inputs.some(i => i.sourceTXID === payment.txid)).toBe(true)
    await acceptBrc29Payment(carol, onward, chain.chainTracker)
    expect(await isMined(payment.txid)).toBe(false)
    expect(await isMined(onward.txid)).toBe(false)
    expect(await spendableSats(carol)).toBe(10_000)
  })

  it('rejects a payment that is not ours, or worth less than claimed', async () => {
    const p = await createBrc29Payment(alice, bob.identityKey, 5_000)
    await expect(acceptBrc29Payment(mallory, p, chain.chainTracker)).rejects.toThrow(/not locked to our key/)
    await expect(acceptBrc29Payment(bob, { ...p, satoshis: 50_000 }, chain.chainTracker)).rejects.toThrow(/not 50000/)
    await acceptBrc29Payment(bob, p, chain.chainTracker)
  })
})

describe('1Sat Ordinals NFTs on a BRC-100 wallet', () => {
  let alice: Wallet, bob: Wallet
  let ka: OrdinalKit, kb: OrdinalKit
  let origin: string

  it('mints an NFT at output 0 into the ordinals basket', async () => {
    ;[alice, bob] = await Promise.all([chain.makeWallet(), chain.makeWallet()])
    await chain.fund(alice)
    await chain.fund(bob) // pays the fee when sending it back
    ka = new OrdinalKit(alice)
    kb = new OrdinalKit(bob)
    const minted = await ka.mint('text/plain', 'Hello from the BSV Blockchain')
    origin = minted.origin
    expect(origin).toBe(`${minted.txid}_0`)
    const [nft] = await ka.list()
    expect(nft).toMatchObject({ origin, contentType: 'text/plain' })
    expect(Buffer.from(nft.data!).toString('utf8')).toBe('Hello from the BSV Blockchain')
  })

  it('transfers it to another identity key; the ordinal stays at input 0 → output 0', async () => {
    const [nft] = await ka.list()
    const delivery = await ka.transfer(nft.outpoint, bob.identityKey)
    const tx = Transaction.fromAtomicBEEF(delivery.tx)
    expect(`${tx.inputs[0].sourceTXID}.${tx.inputs[0].sourceOutputIndex}`).toBe(nft.outpoint)
    expect(tx.outputs[0].satoshis).toBe(1)
    await expect(new OrdinalKit(alice).receive(delivery)).rejects.toThrow(/not a 1-sat output locked to our key/)
    await kb.receive(delivery)
    expect(await ka.list()).toHaveLength(0)
    const [received] = await kb.list()
    expect(received).toMatchObject({ origin, contentType: 'text/plain', outpoint: `${delivery.txid}.0` })
  })

  it('the recipient can move it on (back to Alice), keeping the origin', async () => {
    const [nft] = await kb.list()
    const delivery = await kb.transfer(nft.outpoint, alice.identityKey)
    await ka.receive(delivery)
    const [back] = await ka.list()
    expect(back.origin).toBe(origin)
    expect(await kb.list()).toHaveLength(0)
  })
})

describe('authenticated airdrop (BRC-103/104)', () => {
  let server: Server
  let url: string
  let treasury: Wallet, dave: Wallet

  beforeAll(async () => {
    treasury = await chain.makeWallet()
    await chain.fund(treasury)
    dave = await chain.makeWallet()
    await new Promise<void>(resolve => { server = createAirdropApp(treasury, { satoshis: 2_000 }).listen(18092, resolve) })
    url = 'http://localhost:18092'
  })
  afterAll(async () => { await new Promise(resolve => server?.close(resolve)) })

  it('refuses a request that is not mutually authenticated', async () => {
    const res = await fetch(`${url}/airdrop/claim`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    expect(res.ok).toBe(false)
  })

  it('pays the verified caller once; the second claim is refused', async () => {
    const client = new AuthFetch(dave)
    const first = await client.fetch(`${url}/airdrop/claim`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    expect(first.status).toBe(200)
    const payment = await first.json() as Brc29Payment
    expect(payment.satoshis).toBe(2_000) // the server decides the amount
    await acceptBrc29Payment(dave, payment, chain.chainTracker)
    expect(await spendableSats(dave)).toBe(2_000)
    const second = await client.fetch(`${url}/airdrop/claim`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    expect(second.status).toBe(409)
  })
})
