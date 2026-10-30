/**
 * CryptoPledgePot end to end, offline: real wallet-toolbox wallets on the mock chain
 * (which validates every script, including the sCrypt escrow), the indexer +
 * arbiter over HTTP with BRC-103/104 mutual auth, SPV everywhere.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import { Transaction } from '@bsv/sdk'
import type { Wallet } from '@bsv/wallet-toolbox'
import { CryptoPledgePot } from '../client/cryptoPledgePot'
import { CryptoPledgePotApi } from '../client/cryptoPledgePotApi'
import { createCryptoPledgePotApp } from '../server/app'
import { CryptoPledgePotDb } from '../server/db'
import { campaignIdOf, pledgeTerms } from '../core/campaign'
import { parsePledgeScript, pledgeLockingScript } from '../core/pledge'
import { createMockChain, memoryKnex, type MockChain } from './helpers/mockchain'

let chain: MockChain
let server: Server
let url: string
let arbiter: Wallet
// Timestamps live in the real past so nLockTime-based refunds are final today;
// the server's policy clock is driven by the test.
const T0 = Math.floor(Date.now() / 1000) - 30 * 86_400
let clock = T0

const spendable = async (w: Wallet): Promise<number> =>
  (await w.listOutputs({ basket: 'default', limit: 1000 })).outputs.filter(o => o.spendable).reduce((s, o) => s + o.satoshis, 0)

const as = (w: Wallet): CryptoPledgePot => new CryptoPledgePot(w, new CryptoPledgePotApi(url, w))

beforeAll(async () => {
  chain = await createMockChain()
  arbiter = await chain.makeWallet()
  const db = new CryptoPledgePotDb(memoryKnex())
  await db.migrate()
  const app = createCryptoPledgePotApp({ wallet: arbiter, db, chainTracker: chain.chainTracker, now: () => clock })
  await new Promise<void>(resolve => { server = app.listen(0, () => resolve()) })
  url = `http://127.0.0.1:${(server.address() as any).port}`
})

afterAll(async () => {
  await new Promise(resolve => server?.close(resolve))
  await chain?.close()
})

describe('a funded campaign with three milestones', () => {
  let creator: Wallet, alice: Wallet, bob: Wallet, carol: Wallet, mallory: Wallet
  let campaignId: string
  const api = (): CryptoPledgePotApi => new CryptoPledgePotApi(url)

  it('creator launches: the campaign is anchored on chain and listed', async () => {
    ;[creator, alice, bob, carol, mallory] = await Promise.all([1, 2, 3, 4, 5].map(async () => await chain.makeWallet()))
    for (const w of [creator, alice, bob, carol, mallory]) await chain.fund(w, 200_000)
    clock = T0
    const launched = await as(creator).launch({
      title: 'Solar panels for the village school',
      description: 'Three phases: buy, install, train.',
      goal: 10_000,
      deadline: T0 + 3_600,
      refundAfter: T0 + 7_200,
      milestones: [{ title: 'Buy panels', percent: 25 }, { title: 'Install', percent: 25 }, { title: 'Train staff', percent: 50 }]
    })
    campaignId = launched.campaignId
    expect(campaignId).toBe(campaignIdOf(launched.meta))
    const list = await api().campaigns()
    expect(list.map(c => c.id)).toContain(campaignId)
    expect(list.find(c => c.id === campaignId)).toMatchObject({ status: 'active', raised: 0 })
  })

  it('donors pledge into escrow; every pledge carries an on-chain memo', async () => {
    const { meta } = await api().campaign(campaignId)
    const p = await as(alice).donate(meta, 6_000, { name: 'Alice', message: 'Go solar!' })
    const donationTx = Transaction.fromAtomicBEEF(Array.from(Buffer.from((await api().pledge(p.id)).beef, 'hex')))
    console.log(`donation: ${donationTx.toBinary().length} bytes, fee ${donationTx.getFee()} sats`)
    await as(bob).donate(meta, 3_000, { name: 'Bob' })
    await as(carol).donate(meta, 2_000)
    expect(p).toMatchObject({ amount: 6_000, stage: 0, status: 'active', name: 'Alice', message: 'Go solar!' })
    const detail = await api().campaign(campaignId)
    expect(detail).toMatchObject({ raised: 11_000, escrowed: 11_000, donors: 3, pledges: 3, status: 'active' })
    expect(detail.feed.map(f => f.amount).sort()).toEqual([2_000, 3_000, 6_000])
    // The pledge lives in an escrow script, not in the creator's wallet.
    const { beef } = await api().pledge(p.id)
    const out = Transaction.fromAtomicBEEF(Array.from(Buffer.from(beef, 'hex'))).outputs[Number(p.id.split('.')[1])]
    expect(parsePledgeScript(out.lockingScript)).toMatchObject({ campaignId, pledged: 6_000 })
    expect(out.satoshis).toBe(6_000)
  })

  it('the arbiter refuses to release while the campaign is still raising', async () => {
    await expect(as(creator).release(campaignId)).rejects.toThrow(/no milestone is approved/)
  })

  it('after the deadline with the goal met, milestone 1 (25%) is released to the creator', async () => {
    clock = T0 + 3_601
    expect((await api().campaign(campaignId)).status).toBe('funded')
    const before = await spendable(creator)
    const r = await as(creator).release(campaignId)
    expect(r).toMatchObject({ milestone: 1, released: 2_750 })
    // Released sats land in the creator's wallet as change, minus the miner fee.
    const releaseTx = Transaction.fromAtomicBEEF(Array.from(Buffer.from((await api().pledge((await api().campaign(campaignId)).feed[0].id)).beef, 'hex')))
    const fee = releaseTx.getFee()
    expect(fee).toBeGreaterThan(0)
    expect(fee).toBeLessThan(2_750)
    expect((await spendable(creator)) - before).toBe(2_750 - fee)
    console.log(`release of ${releaseTx.inputs.length} escrows: ${releaseTx.toBinary().length} bytes, fee ${fee} sats`)
    const detail = await api().campaign(campaignId)
    expect(detail).toMatchObject({ released: 2_750, escrowed: 8_250, milestonesReleased: 1 })
    expect(detail.feed.every(p => p.stage === 1 && p.status === 'active')).toBe(true)
  })

  it('milestone 2 needs a progress update and a majority donor vote', async () => {
    await expect(as(creator).release(campaignId)).rejects.toThrow(/no milestone is approved/)
    await as(creator).postUpdate(campaignId, 2, 'Panels are on the roof. Photos: https://example.org/roof')
    expect((await api().campaign(campaignId)).milestones[1].pending).toMatch(/50%/)
    await expect(as(mallory).vote(campaignId, 2, true)).rejects.toThrow(/only donors/)
    await as(carol).vote(campaignId, 2, false)
    await as(bob).vote(campaignId, 2, true) // 3,000 of 11,000: not a majority
    expect((await api().campaign(campaignId)).milestones[1]).toMatchObject({ approved: false, votes: { yes: 3_000, no: 2_000, voters: 2 } })
    await as(alice).vote(campaignId, 2, true) // 9,000 of 11,000
    expect((await api().campaign(campaignId)).milestones[1].approved).toBe(true)
    const r = await as(creator).release(campaignId)
    expect(r).toMatchObject({ milestone: 2, released: 2_750 })
    expect(await api().campaign(campaignId)).toMatchObject({ released: 5_500, escrowed: 5_500 })
  })

  it('the final milestone releases the rest; the campaign completes', async () => {
    await as(creator).postUpdate(campaignId, 3, 'Staff trained.')
    await as(alice).vote(campaignId, 3, true)
    await as(bob).vote(campaignId, 3, true)
    const r = await as(creator).release(campaignId)
    expect(r).toMatchObject({ milestone: 3, released: 5_500 })
    const detail = await api().campaign(campaignId)
    expect(detail).toMatchObject({ status: 'completed', released: 11_000, escrowed: 0, milestonesReleased: 3 })
    expect(detail.feed.every(p => p.status === 'released')).toBe(true)
  })

  it('only the creator can ask for release signatures or post updates', async () => {
    await expect(as(mallory).postUpdate(campaignId, 3, 'fake')).rejects.toThrow(/only the creator/)
  })
})

describe('a failed campaign: donors get their money back', () => {
  let creator: Wallet, alice: Wallet, bob: Wallet
  let campaignId: string
  let alicePledge: string, bobPledge: string

  it('raises less than its goal', async () => {
    ;[creator, alice, bob] = await Promise.all([1, 2, 3].map(async () => await chain.makeWallet()))
    for (const w of [creator, alice, bob]) await chain.fund(w, 100_000)
    clock = T0
    const { campaignId: id, meta } = await as(creator).launch({
      title: 'Too ambitious',
      description: '',
      goal: 50_000,
      deadline: T0 + 3_600,
      refundAfter: T0 + 7_200,
      milestones: [{ title: 'Everything', percent: 100 }]
    })
    campaignId = id
    alicePledge = (await as(alice).donate(meta, 4_000)).id
    bobPledge = (await as(bob).donate(meta, 1_500)).id
  })

  it('early refunds are refused while the campaign is still raising', async () => {
    await expect(as(alice).refund(alicePledge, 'failed', clock)).rejects.toThrow(/failed campaign/)
  })

  it('after the deadline the arbiter co-signs an immediate refund', async () => {
    clock = T0 + 3_601
    expect((await new CryptoPledgePotApi(url).campaign(campaignId)).status).toBe('failed')
    await expect(as(creator).release(campaignId)).rejects.toThrow(/no milestone is approved/)
    const before = await spendable(alice)
    const r = await as(alice).refund(alicePledge, 'failed', clock)
    expect(r.satoshis).toBe(4_000)
    const gained = (await spendable(alice)) - before
    expect(gained).toBeGreaterThan(3_000)
    expect(gained).toBeLessThanOrEqual(4_000)
    expect((await new CryptoPledgePotApi(url).pledge(alicePledge)).pledge.status).toBe('refunded')
  })

  it('another donor cannot claim someone else\'s pledge', async () => {
    await expect(as(alice).refund(bobPledge, 'failed', clock)).rejects.toThrow(/not made from this wallet/)
  })

  it('after refundAfter the donor reclaims alone, with no arbiter involved (nLockTime path)', async () => {
    clock = T0 + 7_201
    const before = await spendable(bob)
    const r = await as(bob).refund(bobPledge, 'deadline', clock)
    const tx = Transaction.fromAtomicBEEF(Array.from(Buffer.from((await new CryptoPledgePotApi(url).pledge(bobPledge)).beef, 'hex')))
    expect(r.satoshis).toBe(1_500)
    expect((await spendable(bob)) - before).toBeGreaterThan(1_000)
    expect((await new CryptoPledgePotApi(url).pledge(bobPledge)).pledge).toMatchObject({ status: 'refunded', spentBy: r.txid })
    expect(tx).toBeDefined()
  })

  it('the campaign view shows nothing left in escrow', async () => {
    expect(await new CryptoPledgePotApi(url).campaign(campaignId)).toMatchObject({ raised: 0, escrowed: 0, status: 'failed' })
  })
})

describe('the indexer rejects pledges that do not match the campaign', () => {
  it('refuses an escrow locked with the wrong arbiter key', async () => {
    const [creator, donor] = await Promise.all([chain.makeWallet(), chain.makeWallet()])
    for (const w of [creator, donor]) await chain.fund(w, 50_000)
    clock = T0
    const { meta } = await as(creator).launch({
      title: 'Honest campaign', description: '', goal: 1_000, deadline: T0 + 3_600, refundAfter: T0 + 7_200, milestones: [{ title: 'All', percent: 100 }]
    })
    const { publicKey: rogue } = await donor.getPublicKey({ protocolID: [1, 'cryptopledgepot donor'], keyID: 'x', counterparty: 'self' })
    // Right campaign id, but an arbiter key the donor controls: CryptoPledgePot must not index it.
    const forged = pledgeLockingScript({ ...pledgeTerms(meta, rogue, 500), arbiter: rogue })
    expect(parsePledgeScript(forged)?.campaignId).toBe(campaignIdOf(meta))
    const res = await donor.createAction({
      description: 'Forged pledge',
      outputs: [{ lockingScript: forged.toHex(), satoshis: 500, outputDescription: 'forged' }],
      options: { randomizeOutputs: false, acceptDelayedBroadcast: false }
    })
    const api = new CryptoPledgePotApi(url, donor)
    await expect(api.registerPledge(Buffer.from(res.tx!).toString('hex'), 0, '00'.repeat(16))).rejects.toThrow(/escrow terms do not match/)
  })
})
