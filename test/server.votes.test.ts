/**
 * Voting and pledge registration edge cases: a 50 % tie, refunded and unknown
 * voters, a changed vote, the same pledge registered twice, a late pledge.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import { PrivateKey } from '@bsv/sdk'
import type { Wallet } from '@bsv/wallet-toolbox'
import type { CampaignMeta } from '../core/campaign'
import { CryptoPledgePot } from '../client/cryptoPledgePot'
import { CryptoPledgePotApi } from '../client/cryptoPledgePotApi'
import { createCryptoPledgePotApp } from '../server/app'
import { CryptoPledgePotDb, type CampaignRow, type PledgeRow, type VoteRow } from '../server/db'
import { campaignView } from '../server/policy'
import { createMockChain, memoryKnex, type MockChain } from './helpers/mockchain'

const key = (): string => PrivateKey.fromRandom().toPublicKey().toString()
const T = 1_800_000_000
const meta: CampaignMeta = {
  v: 1, title: 'Well', description: 'x', goal: 1_000, deadline: T, refundAfter: T + 86_400,
  milestones: [{ title: 'Drill', percent: 50 }, { title: 'Test', percent: 50 }],
  creatorIdentityKey: key(), creatorKey: key(), arbiterKey: key(), nonce: '0'.repeat(32), createdAt: T - 100
}
const row: CampaignRow = { id: 'c1', meta, creatorIdentity: meta.creatorIdentityKey, anchorTxid: 'a', createdAt: T - 100, protocolTag: 'cryptopledgepot' }
const pledge = (donor: string, amount: number, status: PledgeRow['status'] = 'active'): PledgeRow => ({
  id: `${donor}.0`, campaignId: 'c1', donorIdentity: donor, donorKey: key(), donorKeyId: 'k', amount, name: null, message: null, createdAt: T - 50, outpoint: `${donor}.0`, stage: 1, status, spentBy: null
})
const vote = (voter: string, approve: boolean): VoteRow => ({ campaignId: 'c1', milestone: 2, voter, approve, createdAt: T + 10 })
/** Milestone 2 of a funded campaign whose milestone 1 is released and whose update is posted. */
const m2 = (pledges: PledgeRow[], votes: VoteRow[]) => campaignView(row, pledges, [{ campaignId: 'c1', milestone: 1, txid: 'r', amount: 1, createdAt: T + 1 }], [{ campaignId: 'c1', milestone: 2, note: 'done', createdAt: T + 2 }], votes, T + 100).milestones[1]

describe('the vote rule: YES must hold MORE than 50 % of pledged sats', () => {
  it('an exact 50 % tie does not release; one sat more does', () => {
    expect(m2([pledge('a', 500), pledge('b', 500)], [vote('a', true), vote('b', false)]).approved).toBe(false)
    expect(m2([pledge('a', 501), pledge('b', 500)], [vote('a', true), vote('b', false)]).approved).toBe(true)
  })
  it('a refunded donor\'s vote weighs nothing, and so does a stranger\'s', () => {
    const pledges = [pledge('a', 600), pledge('b', 700, 'refunded'), pledge('c', 600)]
    expect(m2(pledges, [vote('b', true), vote('x', true), vote('a', true)]).approved).toBe(false) // 600 of 1,200 still pledged: a tie
    expect(m2(pledges, [vote('a', true), vote('c', true)]).approved).toBe(true)
  })
  it('a changed vote replaces the earlier one (one ballot per donor)', async () => {
    const db = new CryptoPledgePotDb(memoryKnex()); await db.migrate()
    await db.putVote(vote('a', true))
    await db.putVote({ ...vote('a', false), createdAt: T + 20 })
    await db.putVote({ ...vote('a', true), createdAt: T + 30 })
    const votes = await db.votes('c1')
    expect(votes).toHaveLength(1)
    expect(votes[0]).toMatchObject({ approve: true, createdAt: T + 30 })
  })
})

describe('registering pledges', () => {
  let chain: MockChain, server: Server, url: string, creator: Wallet, donor: Wallet
  let clock = Math.floor(Date.now() / 1000) - 30 * 86_400
  beforeAll(async () => {
    chain = await createMockChain()
    const db = new CryptoPledgePotDb(memoryKnex()); await db.migrate()
    const arbiter = await chain.makeWallet()
    await new Promise<void>(resolve => { server = createCryptoPledgePotApp({ wallet: arbiter, db, chainTracker: chain.chainTracker, now: () => clock }).listen(0, () => resolve()) })
    url = `http://127.0.0.1:${(server.address() as any).port}`
    creator = await chain.makeWallet(); await chain.fund(creator, 50_000)
    donor = await chain.makeWallet(); await chain.fund(donor, 50_000)
  }, 120_000)
  afterAll(async () => { await new Promise(r => server?.close(r)); await chain?.close() })

  it('the same pledge registered twice is refused the second time (409), and counted once', async () => {
    const api = new CryptoPledgePotApi(url, donor)
    const { meta: m, campaignId } = await new CryptoPledgePot(creator, new CryptoPledgePotApi(url, creator)).launch({
      title: 'Well', description: 'x', goal: 10_000, deadline: clock + 3_600, refundAfter: clock + 20 * 86_400, milestones: [{ title: 'All', percent: 100 }]
    })
    const p = await new CryptoPledgePot(donor, api).donate(m, 1_000)
    const { beef } = await api.pledge(p.id)
    await expect(api.registerPledge(beef, Number(p.id.split('.')[1]), p.donorKeyId)).rejects.toThrow(/already registered/)
    expect((await api.campaign(campaignId)).raised).toBe(1_000)
  }, 120_000)

  it('a pledge after the deadline is refused', async () => {
    const { meta: m } = await new CryptoPledgePot(creator, new CryptoPledgePotApi(url, creator)).launch({
      title: 'Late', description: 'x', goal: 10_000, deadline: clock + 600, refundAfter: clock + 20 * 86_400, milestones: [{ title: 'All', percent: 100 }]
    })
    clock += 601
    await expect(new CryptoPledgePot(donor, new CryptoPledgePotApi(url, donor)).donate(m, 1_000)).rejects.toThrow(/closed/)
  }, 120_000)
})
