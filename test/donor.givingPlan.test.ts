/**
 * Giving plans: "every month for a year, give to children in need".
 * Plain-language drafts, validation against the mandate, and end to end on the
 * mock chain (real wallets, real server): a good match is given on its own, a
 * weaker one is asked about first, nothing at all is skipped and reported, and
 * in co-pilot every installment waits for the donor's approval.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import type { Wallet } from '@bsv/wallet-toolbox'
import { CryptoPledgePot, type LaunchInput } from '../client/cryptoPledgePot'
import { CryptoPledgePotApi } from '../client/cryptoPledgePotApi'
import { memoryStore } from '../agent/ledger'
import { MockDonorBrain } from '../donor/brain'
import { DonorAgent } from '../donor/donorAgent'
import { addMonths, describePlan, GivingPlanner, MockPlanParser, type GivingPlan } from '../donor/givingPlan'
import { createDonorApp } from '../donor/http'
import { Inbox, type Message } from '../donor/inbox'
import { parseMandate, type Mandate } from '../donor/mandate'
import { MemoBook, type Memo } from '../donor/memo'
import { createCryptoPledgePotApp } from '../server/app'
import { CryptoPledgePotDb } from '../server/db'
import { createMockChain, memoryKnex, type MockChain } from './helpers/mockchain'

const DAY = 86_400

describe('plans in plain words (offline parser)', () => {
  const parse = async (t: string) => await new MockPlanParser().parse(t)

  it('"for a year each month" with an amount and a cause', async () => {
    expect(await parse('For a year, each month donate 5000 sats to children in need')).toMatchObject({ cause: 'children in need', amountSats: 5_000, cadence: 'monthly', occurrences: 12, onWeakMatch: 'ask' })
  })

  it('weekly for three months, and "pick the most similar on your own"', async () => {
    expect(await parse('every week 2k sats for clean water for 3 months, if nothing fits pick the most similar on your own'))
      .toMatchObject({ cause: 'clean water', amountSats: 2_000, cadence: 'weekly', occurrences: 13, onWeakMatch: 'closest' })
  })

  it('"ask me" and "N times"', async () => {
    expect(await parse('give 1,000 sats to animal shelters monthly 6 times, if none fits ask me first')).toMatchObject({ cause: 'animal shelters', amountSats: 1_000, occurrences: 6, onWeakMatch: 'ask' })
  })

  it('needs an amount and a cause', async () => {
    await expect(parse('every month to children')).rejects.toThrow(/how many sats/)
    await expect(parse('every month 500 sats')).rejects.toThrow(/what to support/)
  })

  it('months keep their day, clamped to short months', () => {
    const jan31 = Date.UTC(2027, 0, 31, 12) / 1000
    expect(new Date(addMonths(jan31, 1) * 1000).toISOString().slice(0, 10)).toBe('2027-02-28')
    expect(new Date(addMonths(jan31, 2) * 1000).toISOString().slice(0, 10)).toBe('2027-03-31')
  })

  it('a draft reads back as one sentence to confirm', () => {
    expect(describePlan({ cause: 'children in need', amountSats: 5_000, cadence: 'monthly', occurrences: 12 }))
      .toMatch(/^Every month, 12 time\(s\): 5,000 sats to a campaign about "children in need" \(60,000 sats in total\)\. A good match \(≥ 70%\): your agent gives on its own\. Only a weaker match: it asks you first\./)
  })
})

// ── end to end ──────────────────────────────────────────────────────────────

const T0 = Math.floor(Date.now() / 1000) - 200 * DAY
let clock = T0
let chain: MockChain, server: Server, url: string
let donorWallet: Wallet
const ids: Record<string, string> = {}
const as = (w: Wallet): CryptoPledgePot => new CryptoPledgePot(w, new CryptoPledgePotApi(url, w))
const txExists = async (txid: string): Promise<boolean> => (await (chain.services as any).storage.getTransaction(txid)) != null
const campaign = (title: string, description: string, days: number): LaunchInput => ({
  title, description, goal: 50_000, deadline: clock + days * DAY, refundAfter: clock + (days + 30) * DAY,
  milestones: [{ title: 'Buy supplies and publish invoices', percent: 50 }, { title: 'Deliver and report', percent: 50 }]
})
const setup = (mode: 'autopilot' | 'copilot', mandate: Partial<Mandate> = {}) => {
  const memos = new MemoBook(memoryStore<Memo[]>([]))
  const agent = new DonorAgent(parseMandate({ name: 'Kids', mode, interests: 'children', budget: { totalSats: 20_000, perPledgeMaxSats: 5_000, perCreatorMaxPct: 100 }, ...mandate }), {
    api: new CryptoPledgePotApi(url, donorWallet), client: mode === 'autopilot' ? as(donorWallet) : undefined, brain: new MockDonorBrain(), memos, chainTracker: chain.chainTracker, txExists, now: () => clock, log: () => {}
  })
  const messages: Message[] = []
  const planner = new GivingPlanner(agent, { plans: memoryStore<GivingPlan[]>([]), inbox: new Inbox(memoryStore<Message[]>([])), notify: async m => { messages.push(m) }, log: () => {} })
  return { agent, memos, planner, messages }
}

beforeAll(async () => {
  chain = await createMockChain()
  const db = new CryptoPledgePotDb(memoryKnex()); await db.migrate()
  const arbiter = await chain.makeWallet()
  await new Promise<void>(resolve => { server = createCryptoPledgePotApp({ wallet: arbiter, db, chainTracker: chain.chainTracker, now: () => clock }).listen(0, () => resolve()) })
  url = `http://127.0.0.1:${(server.address() as any).port}`
  // Three NGOs: a missed goal by one must not count against the others' records.
  const [library, kitchen, drillers] = [await chain.makeWallet(), await chain.makeWallet(), await chain.makeWallet()]
  donorWallet = await chain.makeWallet()
  for (const w of [library, kitchen, drillers]) await chain.fund(w, 20_000)
  await chain.fund(donorWallet, 100_000)
  ids.books = (await as(library).launch(campaign('Books for children in Kibera', 'A library corner with 500 books for children in need.', 20))).campaignId
  ids.meals = (await as(kitchen).launch(campaign('Hot meals for orphans in Malawi', 'Daily hot meals for 120 orphans for one term.', 50))).campaignId
  ids.well = (await as(drillers).launch(campaign('Drill a water well in Kitui', 'One borehole with a hand pump for 800 people.', 200))).campaignId
}, 120_000)
afterAll(async () => { await new Promise(r => server?.close(r)); await chain?.close() })

describe('autopilot: a monthly plan for children in need', () => {
  let s: ReturnType<typeof setup>
  let plan: GivingPlan

  it('the plan must fit the donor\'s limits', () => {
    s = setup('autopilot')
    expect(() => s.planner.create({ cause: 'children in need', amountSats: 6_000, cadence: 'monthly', occurrences: 3 })).toThrow(/per-pledge limit/)
    expect(() => s.planner.create({ cause: 'children in need', amountSats: 5_000, cadence: 'monthly', occurrences: 5 })).toThrow(/needs 25,000 sats but only 20,000/)
    plan = s.planner.create({ cause: 'children in need', amountSats: 2_000, cadence: 'monthly', occurrences: 3, startAt: clock + 3_600 })
    expect(plan.installments.map(i => i.status)).toEqual(['due', 'due', 'due'])
  })

  it('nothing happens before the first due date', async () => {
    expect((await s.planner.step()).due).toBe(0)
  })

  it('month 1: a good match, so the agent gives on its own', async () => {
    clock += 3_600
    expect(await s.planner.step()).toMatchObject({ due: 1, given: 1 })
    const first = s.planner.get(plan.id)!.installments[0]
    expect(first).toMatchObject({ status: 'given', campaignId: ids.books, amount: 2_000, relevance: 100 })
    expect((await new CryptoPledgePotApi(url).campaign(ids.books)).raised).toBe(2_000)
    expect(s.memos.all().at(-1)).toMatchObject({ kind: 'pledge', status: 'executed', planId: plan.id, installment: 1 })
    expect(s.messages.at(-1)!.text).toMatch(/Gave 2,000 sats to "Books for children in Kibera" for installment 1\/3/)
  })

  it('month 2: only a weaker match is open, so the agent asks first', async () => {
    clock = addMonths(T0 + 3_600, 1)
    expect(await s.planner.step()).toMatchObject({ due: 1, asked: 1 })
    const q = s.messages.at(-1)!
    expect(q).toMatchObject({ kind: 'question', status: 'open', installment: 2 })
    expect(q.options!.map(o => o.title)).toEqual(['Hot meals for orphans in Malawi'])
    expect(q.text).toMatch(/No campaign fits "children in need" well right now; the closest is a 60% match/)
    await expect(s.planner.answer(q.id, ids.well)).rejects.toThrow(/one of the offered campaigns/)
    expect(await s.planner.answer(q.id, ids.meals)).toMatchObject({ status: 'given', campaignId: ids.meals, amount: 2_000 })
    await expect(s.planner.answer(q.id, 'skip')).rejects.toThrow(/answered/)
  })

  it('month 3: nothing about children is open: skipped, the donor is told, the plan finishes', async () => {
    clock = addMonths(T0 + 3_600, 2)
    expect(await s.planner.step()).toMatchObject({ due: 1, skipped: 1 })
    expect(s.planner.get(plan.id)!.status).toBe('completed')
    expect(s.messages.slice(-2).map(m => m.text)).toEqual([
      'Skipped installment 3/3 of "children in need": no open campaign about "children in need" passes your terms. The sats stay in your budget.',
      'Giving plan "children in need" finished: 2 of 3 installment(s) given, 4,000 sats in total.'
    ])
  })
})

describe('the plan\'s choices when nothing fits well', () => {
  it('"closest": the agent gives to the most similar campaign on its own', async () => {
    clock = T0 + 10 * DAY
    const s = setup('autopilot')
    const plan = s.planner.create({ cause: 'children in need', amountSats: 1_000, cadence: 'weekly', occurrences: 1, onWeakMatch: 'closest', goodMatch: 90 })
    await s.planner.step()
    expect(s.planner.get(plan.id)!.installments[0]).toMatchObject({ status: 'given', campaignId: ids.books })
  })

  it('an unanswered question expires and that installment is skipped', async () => {
    clock = T0 + 30 * DAY // books closed, meals open (a 60% match)
    const s = setup('autopilot')
    const plan = s.planner.create({ cause: 'children in need', amountSats: 1_000, cadence: 'weekly', occurrences: 1, askTimeoutHours: 24 })
    expect((await s.planner.step()).asked).toBe(1)
    clock += 25 * 3_600
    await s.planner.step()
    expect(s.planner.get(plan.id)!.installments[0]).toMatchObject({ status: 'skipped', note: 'no answer in time' })
    expect(s.planner.deps.inbox.all()[0].status).toBe('expired')
  })
})

describe('co-pilot: every installment waits for the donor', () => {
  it('proposes, the donor pays from their wallet, the installment counts as given', async () => {
    clock = T0 + 30 * DAY
    const s = setup('copilot', { donorIdentityKey: donorWallet.identityKey })
    const plan = s.planner.create({ cause: 'school meals', amountSats: 1_500, cadence: 'monthly', occurrences: 1, goodMatch: 40 })
    expect((await s.planner.step()).proposed).toBe(1)
    const memo = s.memos.all().find(m => m.status === 'proposed')!
    expect(memo).toMatchObject({ campaignId: ids.meals, amount: 1_500, planId: plan.id })
    expect(s.messages.at(-1)!.text).toMatch(/Approve it on your donor agent page/)
    const pledge = await as(donorWallet).donate((await new CryptoPledgePotApi(url).campaign(ids.meals)).meta, 1_500)
    await s.agent.approve(memo.id, pledge.id)
    await s.planner.step()
    expect(s.planner.get(plan.id)!).toMatchObject({ status: 'completed', installments: [{ status: 'given', amount: 1_500 }] })
  })
})

describe('over the donor agent\'s API', () => {
  it('draft from plain words, confirm, list, pause', async () => {
    const s = setup('autopilot')
    const app = createDonorApp({ agent: s.agent, lastStep: () => undefined, runStep: async () => await s.agent.step(), planner: s.planner, planParser: new MockPlanParser() })
    const base = await new Promise<string>(resolve => { const srv = app.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(srv.address() as any).port}`)); afterAll(async () => { await new Promise(r => srv.close(r)) }) })
    const post = async (p: string, body: unknown = {}) => { const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json() } }
    const draft = await post('/api/donor/plans/draft', { text: 'every month for 6 months 1000 sats to children in need, otherwise choose the closest on your own' })
    expect(draft.json.draft).toMatchObject({ cause: 'children in need', amountSats: 1_000, occurrences: 6, onWeakMatch: 'closest' })
    expect(draft.json.description).toMatch(/gives to the closest match on its own/)
    const created = await post('/api/donor/plans', draft.json.draft)
    expect(created.status).toBe(200)
    expect((await (await fetch(`${base}/api/donor/plans`)).json()).map((p: GivingPlan) => p.id)).toEqual([created.json.id])
    expect((await post(`/api/donor/plans/${created.json.id as string}/pause`)).json.status).toBe('paused')
    expect((await post('/api/donor/plans', { cause: '', amountSats: 1_000, cadence: 'monthly', occurrences: 1 })).status).toBe(400)
  })
})
