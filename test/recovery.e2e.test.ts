/**
 * Recovery, replaying what happened for real on 30 Oct 2026:
 *  - a campaign + pledge made under the app's old name ('bitfund' keys and
 *    records) whose local index was deleted → import from chain, claim, release;
 *  - a donation into an escrow whose campaign no server knows (the offline-demo
 *    incident) → reclaimed by the donor alone, without any server.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import { Random, Transaction, Utils } from '@bsv/sdk'
import type { Wallet } from '@bsv/wallet-toolbox'
import { CryptoPledgePot } from '../client/cryptoPledgePot'
import { CryptoPledgePotApi } from '../client/cryptoPledgePotApi'
import { createCryptoPledgePotApp } from '../server/app'
import { CryptoPledgePotDb } from '../server/db'
import { campaignAnchorScript, campaignIdOf, pledgeMemoScript, pledgeScriptFor, protocolsFor, type CampaignMeta } from '../core/campaign'
import { createMockChain, memoryKnex, type MockChain } from './helpers/mockchain'

const T0 = Math.floor(Date.now() / 1000) - 30 * 86_400
let clock = T0
let chain: MockChain
let server: Server
let url: string
let arbiter: Wallet
const legacy = protocolsFor('bitfund')
const hex = (b: number[] | Uint8Array): string => Utils.toHex(Array.from(b))
const as = (w: Wallet): CryptoPledgePot => new CryptoPledgePot(w, new CryptoPledgePotApi(url, w))
const spendable = async (w: Wallet): Promise<number> =>
  (await w.listOutputs({ basket: 'default', limit: 1000 })).outputs.filter(o => o.spendable).reduce((s, o) => s + o.satoshis, 0)

/** What the pre-rename app did: anchor a campaign with 'bitfund' keys and record tag. */
async function legacyLaunch (creator: Wallet, goal: number): Promise<{ meta: CampaignMeta, tx: number[] }> {
  const nonce = Utils.toHex(Random(16))
  const meta: CampaignMeta = {
    v: 1, title: 'Fund a well', description: '', goal, deadline: T0 + 3_600, refundAfter: T0 + 7_200,
    milestones: [{ title: 'Kick-off', percent: 30 }, { title: 'Deliver', percent: 70 }],
    creatorIdentityKey: creator.identityKey,
    creatorKey: (await creator.getPublicKey({ protocolID: legacy.creator, keyID: nonce, counterparty: 'self' })).publicKey,
    arbiterKey: (await arbiter.getPublicKey({ protocolID: legacy.arbiter, keyID: nonce, counterparty: 'self' })).publicKey,
    nonce,
    createdAt: T0
  }
  const r = await creator.createAction({ description: 'Launch BitFund campaign', outputs: [{ lockingScript: campaignAnchorScript(meta, 'bitfund').toHex(), satoshis: 0, outputDescription: 'campaign' }], options: { randomizeOutputs: false, acceptDelayedBroadcast: false } })
  return { meta, tx: Array.from(r.tx!) }
}

/** What the pre-rename app did for a donation: 'bitfund donor' key, 'bitfund pledges' basket, 'bitfund' memo. */
async function legacyDonate (donor: Wallet, meta: CampaignMeta, sats: number): Promise<{ tx: number[], outpoint: string }> {
  const keyID = Utils.toHex(Random(16))
  const donorKey = (await donor.getPublicKey({ protocolID: legacy.donor, keyID, counterparty: 'self' })).publicKey
  const lockingScript = pledgeScriptFor(meta, donorKey, sats).toHex()
  const r = await donor.createAction({
    description: 'Pledge',
    outputs: [
      { lockingScript, satoshis: sats, outputDescription: 'escrow', basket: legacy.basket, customInstructions: JSON.stringify({ protocolID: legacy.donor, keyID, counterparty: 'self' }), tags: ['bitfund'] },
      { lockingScript: pledgeMemoScript(campaignIdOf(meta), { name: 'Old donor', message: 'from before the rename' }, 'bitfund').toHex(), satoshis: 0, outputDescription: 'donation memo' }
    ],
    options: { randomizeOutputs: false, acceptDelayedBroadcast: false }
  })
  return { tx: Array.from(r.tx!), outpoint: `${r.txid!}.0` }
}

beforeAll(async () => {
  chain = await createMockChain()
  arbiter = await chain.makeWallet()
  const db = new CryptoPledgePotDb(memoryKnex())
  await db.migrate()
  await new Promise<void>(resolve => { server = createCryptoPledgePotApp({ wallet: arbiter, db, chainTracker: chain.chainTracker, now: () => clock }).listen(0, () => resolve()) })
  url = `http://127.0.0.1:${(server.address() as any).port}`
})
afterAll(async () => { await new Promise(r => server?.close(r)); await chain?.close() })

describe('a legacy (pre-rename) campaign whose index was lost', () => {
  let creator: Wallet, donor: Wallet, other: Wallet
  let meta: CampaignMeta, anchorTx: number[], pledge: { tx: number[], outpoint: string }
  const api = (): CryptoPledgePotApi => new CryptoPledgePotApi(url)

  it('is rebuilt from its on-chain anchor, keeping the legacy tag', async () => {
    ;[creator, donor, other] = [await chain.makeWallet(), await chain.makeWallet(), await chain.makeWallet()]
    for (const w of [creator, donor, other]) await chain.fund(w, 100_000)
    ;({ meta, tx: anchorTx } = await legacyLaunch(creator, 5_000))
    pledge = await legacyDonate(donor, meta, 6_000)
    clock = T0
    const r = await api().importTx(hex(anchorTx))
    expect(r.campaigns).toEqual([campaignIdOf(meta)])
    const view = await api().campaign(campaignIdOf(meta))
    expect(view).toMatchObject({ protocolTag: 'bitfund', status: 'active', raised: 0 })
  })

  it('imports the original pledge as unclaimed; importing again changes nothing', async () => {
    const r = await api().importTx(hex(pledge.tx))
    expect(r.pledges).toEqual([pledge.outpoint])
    expect((await api().pledge(pledge.outpoint)).pledge).toMatchObject({ amount: 6_000, donorIdentity: '', donorKeyId: '', name: 'Old donor', status: 'active' })
    expect((await api().campaign(campaignIdOf(meta))).raised).toBe(6_000)
    const again = await api().importTx(hex(pledge.tx))
    expect(again.pledges).toEqual([])
    expect(again.skipped[0]).toMatch(/already indexed/)
  })

  it('refuses to import a campaign that names another server\'s arbiter', async () => {
    const stranger = await chain.makeWallet()
    const { meta: m } = await legacyLaunch(creator, 1_000)
    const foreign: CampaignMeta = { ...m, arbiterKey: (await stranger.getPublicKey({ protocolID: legacy.arbiter, keyID: m.nonce, counterparty: 'self' })).publicKey }
    const r = await creator.createAction({ description: 'foreign campaign', outputs: [{ lockingScript: campaignAnchorScript(foreign, 'bitfund').toHex(), satoshis: 0, outputDescription: 'campaign record' }], options: { acceptDelayedBroadcast: false } })
    const res = await api().importTx(hex(r.tx!))
    expect(res.campaigns).toEqual([])
    expect(res.skipped[0]).toMatch(/arbiter key is not this server's/)
  })

  it('only the real donor can claim it: a forged claim is refused, the donor\'s wallet claims it', async () => {
    await expect(new CryptoPledgePotApi(url, other).claimPledge(pledge.outpoint, '00'.repeat(16), '3006020101020101')).rejects.toThrow(/does not prove control/)
    await expect(as(other).claim(pledge.outpoint)).rejects.toThrow(/does not hold the donor key/)
    expect(await as(donor).claimWalletPledges()).toEqual([pledge.outpoint])
    const p = (await api().pledge(pledge.outpoint)).pledge
    expect(p.donorIdentity).toBe(donor.identityKey)
    expect(p.donorKeyId).toMatch(/^[0-9a-f]{32}$/)
    await expect(new CryptoPledgePotApi(url, other).claimPledge(pledge.outpoint, p.donorKeyId, '3006020101020101')).rejects.toThrow(/already claimed/)
  })

  it('the creator releases milestone 1 with the legacy keys (creator and arbiter)', async () => {
    clock = T0 + 3_601
    const before = await spendable(creator)
    const r = await as(creator).release(campaignIdOf(meta))
    expect(r).toMatchObject({ milestone: 1, released: 1_800 }) // 30% of 6,000
    expect(await spendable(creator)).toBeGreaterThan(before)
    expect((await api().pledge(pledge.outpoint)).pledge).toMatchObject({ stage: 1, escrowed: 4_200 })
  })

  it('after the refund date the donor reclaims the remainder through the app (legacy donor key)', async () => {
    clock = T0 + 7_201
    const before = await spendable(donor)
    const r = await as(donor).refund(pledge.outpoint, 'deadline', clock)
    expect(r.satoshis).toBe(4_200)
    expect(await spendable(donor)).toBeGreaterThan(before + 3_000)
    expect((await api().pledge(pledge.outpoint)).pledge.status).toBe('refunded')
  })
})

describe('an orphaned escrow (its campaign is on no server)', () => {
  it('is reclaimed by the donor alone, from chain data only, once the refund date has passed', async () => {
    const donor = await chain.makeWallet()
    const ghostCreator = await chain.makeWallet()
    await chain.fund(donor, 50_000)
    // A campaign that only ever existed in a demo process: never registered here.
    const nonce = Utils.toHex(Random(16))
    const ghost: CampaignMeta = {
      v: 1, title: 'Simulated demo campaign', description: '', goal: 1_000_000, deadline: T0 + 60, refundAfter: T0 + 120,
      milestones: [{ title: 'All', percent: 100 }], creatorIdentityKey: ghostCreator.identityKey,
      creatorKey: (await ghostCreator.getPublicKey({ protocolID: protocolsFor('cryptopledgepot').creator, keyID: nonce, counterparty: 'self' })).publicKey,
      arbiterKey: (await ghostCreator.getPublicKey({ protocolID: protocolsFor('cryptopledgepot').arbiter, keyID: nonce, counterparty: 'self' })).publicKey,
      nonce, createdAt: T0
    }
    const d = await as(donor).donate(ghost, 10_000).catch(e => e as Error) // the server rejects it: unknown campaign …
    expect(String(d)).toMatch(/campaign not found/)
    // … but the escrow was already broadcast, exactly like the real incident.
    const { outputs } = await donor.listOutputs({ basket: protocolsFor('cryptopledgepot').basket, limit: 10 })
    const outpoint = outputs[0].outpoint
    const beefByTxid = new Map<string, string>()
    const { BEEF } = await donor.listOutputs({ basket: protocolsFor('cryptopledgepot').basket, include: 'entire transactions', limit: 10 })
    const txid = outpoint.split('.')[0]
    beefByTxid.set(txid, hex(Transaction.fromBEEF(Array.from(BEEF!), txid).toAtomicBEEF()))
    const fetchBeef = async (id: string): Promise<string> => beefByTxid.get(id)!

    await expect(as(donor).reclaimEscrow(outpoint, { fetchBeef, now: T0 + 100 })).rejects.toThrow(/can be reclaimed alone from/)
    const stranger = await chain.makeWallet()
    await expect(as(stranger).reclaimEscrow(outpoint, { fetchBeef, now: T0 + 121 })).rejects.toThrow(/does not hold the donor key/)
    const before = await spendable(donor)
    const r = await as(donor).reclaimEscrow(outpoint, { fetchBeef, now: T0 + 121 })
    expect(r.satoshis).toBe(10_000)
    expect(await spendable(donor)).toBeGreaterThan(before + 9_000)
  })
})
