/** The donor agent's own API (what the "My donor agent" page uses), over HTTP. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import type { Wallet } from '@bsv/wallet-toolbox'
import { CryptoPledgePot } from '../client/cryptoPledgePot'
import { CryptoPledgePotApi } from '../client/cryptoPledgePotApi'
import { createBrc29Payment } from '../client/payments'
import { createCryptoPledgePotApp } from '../server/app'
import { CryptoPledgePotDb } from '../server/db'
import { memoryStore } from '../shared/store'
import { MockDonorBrain } from '../donor-agent/brain'
import { DonorAgent, type StepSummary } from '../donor-agent/donorAgent'
import { createDonorApp } from '../donor-agent/http'
import { parseMandate } from '../donor-agent/mandate'
import { MemoBook, type Memo } from '../donor-agent/memo'
import { createMockChain, memoryKnex, type MockChain } from './helpers/mockchain'

let chain: MockChain
const servers: Server[] = []
let url: string
const clock = Math.floor(Date.now() / 1000) - 30 * 86_400
const listen = async (app: any): Promise<string> => await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(s.address() as any).port}`)); servers.push(s) })
const post = async (base: string, path: string, body: unknown = {}): Promise<{ status: number, json: any }> => {
  const r = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  return { status: r.status, json: await r.json() }
}
const donorAppFor = async (agent: DonorAgent, wallet?: Wallet): Promise<string> => {
  let last: StepSummary | undefined
  const spendable = async (): Promise<number> => wallet === undefined ? 0 : (await wallet.listOutputs({ basket: 'default', limit: 1000 })).outputs.filter(o => o.spendable).reduce((s, o) => s + o.satoshis, 0)
  return await listen(createDonorApp({ agent, wallet, chainTracker: chain.chainTracker, spendable, lastStep: () => last, runStep: async () => (last = await agent.step()) }))
}

beforeAll(async () => {
  chain = await createMockChain()
  const db = new CryptoPledgePotDb(memoryKnex()); await db.migrate()
  url = await listen(createCryptoPledgePotApp({ wallet: await chain.makeWallet(), db, chainTracker: chain.chainTracker, now: () => clock }))
}, 120_000)
afterAll(async () => { for (const s of servers) await new Promise(r => s.close(r)); await chain?.close() })

describe('donor agent HTTP API', () => {
  let donor: Wallet, d: string, campaignId: string

  it('co-pilot: status, a round, proposals, approve with the donor\'s real pledge, decline', async () => {
    const creator = await chain.makeWallet(); donor = await chain.makeWallet()
    for (const w of [creator, donor]) await chain.fund(w, 60_000)
    const c = new CryptoPledgePot(creator, new CryptoPledgePotApi(url, creator))
    const base = { description: 'Two protected springs with monthly water test reports.', goal: 5_000, deadline: clock + 3_600, refundAfter: clock + 20 * 86_400, milestones: [{ title: 'Survey and permits', percent: 50 }, { title: 'Publish water tests', percent: 50 }] }
    campaignId = (await c.launch({ ...base, title: 'Protect two water springs' })).campaignId
    const second = (await c.launch({ ...base, title: 'Water tank repair' })).campaignId
    const agent = new DonorAgent(parseMandate({ name: 'Water first', mode: 'copilot', keywords: ['water'], donorIdentityKey: donor.identityKey, budget: { totalSats: 10_000, perPledgeMaxSats: 4_000, perCreatorMaxPct: 100 } }),
      { api: new CryptoPledgePotApi(url), brain: new MockDonorBrain(), memos: new MemoBook(memoryStore<Memo[]>([])), chainTracker: chain.chainTracker, txExists: async () => false, now: () => clock, log: () => {} })
    d = await donorAppFor(agent)

    expect((await (await fetch(`${d}/api/donor`)).json())).toMatchObject({ mode: 'copilot', wallet: null, budget: { totalSats: 10_000, left: 10_000 } })
    expect((await post(d, '/api/donor/step')).json).toMatchObject({ evaluated: 2, proposed: 2 })
    const memos: Memo[] = await (await fetch(`${d}/api/donor/memos`)).json()
    const p1 = memos.find(m => m.campaignId === campaignId)!
    const p2 = memos.find(m => m.campaignId === second)!
    const status = await (await fetch(`${d}/api/donor`)).json()
    expect(status.budget).toMatchObject({ reserved: p1.amount! + p2.amount!, left: 10_000 - p1.amount! - p2.amount! })
    expect(status.counts.proposals).toBe(2)

    // What the page does on "Approve & pay": pay from the donor's own wallet, then report the pledge.
    const meta = (await new CryptoPledgePotApi(url).campaign(campaignId)).meta
    const pledge = await new CryptoPledgePot(donor, new CryptoPledgePotApi(url, donor)).donate(meta, p1.amount!)
    expect((await post(d, `/api/donor/memos/${p1.id}/approve`, { pledgeId: 'not-an-outpoint' })).status).toBe(400)
    expect((await post(d, `/api/donor/memos/${p1.id}/approve`, { pledgeId: pledge.id })).json).toMatchObject({ status: 'executed', pledgeId: pledge.id })
    expect((await post(d, `/api/donor/memos/${p2.id}/decline`)).json).toMatchObject({ status: 'declined' })
    const after = await (await fetch(`${d}/api/donor`)).json()
    expect(after.budget).toMatchObject({ pledged: p1.amount, reserved: 0, left: 10_000 - p1.amount! })
    expect(after.counts).toMatchObject({ proposals: 0, pledges: 1 })
    expect((await post(d, '/api/donor/fund', {})).json.error).toMatch(/only an autopilot agent/)
  })

  it('autopilot: the donor moves budget into the agent\'s wallet with a BRC-29 payment', async () => {
    const agentWallet = await chain.makeWallet()
    const agent = new DonorAgent(parseMandate({ name: 'Auto', mode: 'autopilot', keywords: ['water'] }),
      { api: new CryptoPledgePotApi(url, agentWallet), client: new CryptoPledgePot(agentWallet, new CryptoPledgePotApi(url, agentWallet)), brain: new MockDonorBrain(), memos: new MemoBook(memoryStore<Memo[]>([])), chainTracker: chain.chainTracker, txExists: async () => false, now: () => clock, log: () => {} })
    const a = await donorAppFor(agent, agentWallet)
    const st = await (await fetch(`${a}/api/donor`)).json()
    expect(st.wallet).toMatchObject({ identityKey: agentWallet.identityKey, balance: 0 })
    const payment = await createBrc29Payment(donor, agentWallet.identityKey, 7_000, 'Donor agent budget')
    expect((await post(a, '/api/donor/fund', payment)).json).toMatchObject({ ok: true, balance: 7_000 })
  })
})
