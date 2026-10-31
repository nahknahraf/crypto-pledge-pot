/**
 * The compliance agent, end to end on the mock chain (real wallets, real
 * server, SPV). Two NGOs with payment plans:
 *  - one spends only part of milestone 1: releases stop, the grace period
 *    starts, it pays the rest back to the donors pro rata, the donors collect
 *    it, and milestone 2 can go ahead;
 *  - one spends nothing: after the grace period the campaign is in breach, a
 *    breach record goes on chain, and a donor's autopilot agent reclaims the
 *    remaining escrow early, co-signed by the arbiter.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import { P2PKH, PrivateKey, Transaction, Utils } from '@bsv/sdk'
import type { Wallet } from '@bsv/wallet-toolbox'
import { CryptoPledgePot, type LaunchInput } from '../client/cryptoPledgePot'
import { CryptoPledgePotApi } from '../client/cryptoPledgePotApi'
import { breachRecordScript, parseCryptoPledgePotRecord } from '../core/campaign'
import { defaultLegalTerms, type PaymentPlan } from '../core/paymentPlan'
import { memoryStore } from '../agent/ledger'
import { ComplianceAgent, EMPTY_STATE, type ComplianceAgentState, type Notice } from '../compliance/complianceAgent'
import { MockDonorBrain } from '../donor/brain'
import { DonorAgent } from '../donor/donorAgent'
import { parseMandate } from '../donor/mandate'
import { MemoBook, type Memo } from '../donor/memo'
import { createCryptoPledgePotApp } from '../server/app'
import { CryptoPledgePotDb } from '../server/db'
import { createMockChain, memoryKnex, type MockChain } from './helpers/mockchain'

const DAY = 86_400
const T0 = Math.floor(Date.now() / 1000) - 120 * DAY
let clock = T0
let chain: MockChain, server: Server, url: string
let ngo: Wallet, careless: Wallet, alice: Wallet, bob: Wallet, auditorAgent: Wallet
let agent: ComplianceAgent
const delivered: Notice[] = []
const as = (w: Wallet): CryptoPledgePot => new CryptoPledgePot(w, new CryptoPledgePotApi(url, w))
const api = (): CryptoPledgePotApi => new CryptoPledgePotApi(url)
const spendable = async (w: Wallet): Promise<number> =>
  (await w.listOutputs({ basket: 'default', limit: 1000 })).outputs.filter(o => o.spendable).reduce((s, o) => s + o.satoshis, 0)
const filters = new P2PKH().lock(PrivateKey.fromRandom().toAddress()).toHex()
const pumps = new P2PKH().lock(PrivateKey.fromRandom().toAddress()).toHex()

const plan: PaymentPlan = {
  v: 1, tolerancePercent: 10, reportDays: 30, graceDays: 7, legalTerms: defaultLegalTerms(),
  milestones: [
    { lines: [{ id: 'filters', category: 'Water filters', percent: 70, payee: { kind: 'onchain', name: 'AquaPure Ltd', lockingScript: filters } }, { id: 'pumps', category: 'Hand pumps', percent: 30, payee: { kind: 'onchain', name: 'PumpCo', lockingScript: pumps } }] },
    { lines: [{ id: 'install', category: 'Installation', percent: 100, payee: { kind: 'onchain', name: 'AquaPure Ltd', lockingScript: filters } }] }
  ]
}
const input = (title: string): LaunchInput => ({
  title, description: 'Filters and pumps for three village schools; every payment is on chain.',
  goal: 10_000, deadline: clock + 3_600, refundAfter: clock + 100 * DAY,
  milestones: [{ title: 'Buy filters and pumps', percent: 50 }, { title: 'Install everything', percent: 50 }],
  paymentPlan: plan
})

beforeAll(async () => {
  chain = await createMockChain()
  const db = new CryptoPledgePotDb(memoryKnex()); await db.migrate()
  const arbiter = await chain.makeWallet()
  await new Promise<void>(resolve => { server = createCryptoPledgePotApp({ wallet: arbiter, db, chainTracker: chain.chainTracker, now: () => clock }).listen(0, () => resolve()) })
  url = `http://127.0.0.1:${(server.address() as any).port}`
  ;[ngo, careless, alice, bob, auditorAgent] = [await chain.makeWallet(), await chain.makeWallet(), await chain.makeWallet(), await chain.makeWallet(), await chain.makeWallet()]
  for (const w of [ngo, careless, alice, bob, auditorAgent]) await chain.fund(w, 50_000) // one at a time: no funding races
  agent = new ComplianceAgent({
    api: api(),
    store: memoryStore<ComplianceAgentState>(EMPTY_STATE),
    anchor: async (campaignId, record) => (await auditorAgent.createAction({
      description: 'CryptoPledgePot breach record',
      outputs: [{ lockingScript: breachRecordScript(campaignId, record).toHex(), satoshis: 0, outputDescription: 'Payment plan breach record' }],
      options: { randomizeOutputs: false, acceptDelayedBroadcast: false }
    })).txid!,
    notify: async n => { delivered.push(n) },
    now: () => clock,
    log: () => {}
  })
}, 120_000)
afterAll(async () => { await new Promise(r => server?.close(r)); await chain?.close() })

describe('an NGO that spends only part of a milestone, then pays the rest back', () => {
  let id: string

  it('milestone 1 is released and the agent tells the NGO what to spend by when', async () => {
    id = (await as(ngo).launch(input('Filters for Kitui schools'))).campaignId
    const meta = (await api().campaign(id)).meta
    await as(alice).donate(meta, 6_000)
    await as(bob).donate(meta, 4_000)
    clock += 3_601
    expect((await as(ngo).release(id)).released).toBe(5_000)
    await agent.step()
    const opened = agent.notices().find(n => n.kind === 'opened')!
    expect(opened.to).toBe('ngo')
    expect(opened.text).toMatch(/5,000 sats released.*Water filters → AquaPure Ltd: 3,500 sats; Hand pumps → PumpCo: 1,500 sats/)
  })

  it('pays the filters but not the pumps: milestone 2 stays locked even with the donors\' YES', async () => {
    await as(ngo).payPlanLine(id, 1, 'filters', 3_500)
    await as(ngo).postUpdate(id, 2, 'Filters delivered, see the payment on chain.')
    await as(alice).vote(id, 2, true)
    await as(bob).vote(id, 2, true)
    const m2 = (await api().campaign(id)).milestones[1]
    expect(m2.approved).toBe(false)
    expect(m2.pending).toMatch(/milestone 1 spending is not yet in line with the payment plan \(reporting\)/)
    await expect(as(ngo).release(id)).rejects.toThrow(/nothing to release/)
  })

  it('reminds the NGO before the report date, then opens the 7-day grace period', async () => {
    clock += 28 * DAY
    await agent.step()
    expect(agent.notices().at(-1)).toMatchObject({ kind: 'reminder', to: 'ngo' })
    expect(agent.notices().at(-1)!.text).toMatch(/Still open: Hand pumps → PumpCo: 0 of 1,500 sats/)
    clock += 3 * DAY
    await agent.step()
    const grace = agent.notices().at(-1)!
    expect(grace).toMatchObject({ kind: 'grace', to: 'everyone' })
    expect(grace.text).toMatch(/pay 1,500 sats back to the donors/)
    expect((await api().campaign(id)).milestones[0].compliance).toMatchObject({ state: 'grace', dueBackSats: 1_500 })
  })

  it('the NGO repays 1,500 sats pro rata in one transaction; the milestone counts as repaid', async () => {
    const owed = await api().repaymentPlan(id, 1)
    expect(owed.outstanding.map(o => o.sats).sort()).toEqual([600, 900])
    expect(await as(ngo).repay(id, 1)).toMatchObject({ sats: 1_500 })
    expect((await api().campaign(id)).milestones[0].compliance).toMatchObject({ state: 'repaid', repaidSats: 1_500 })
    await agent.step()
    expect(agent.notices().at(-1)).toMatchObject({ kind: 'resolved' })
    await expect(as(ngo).repay(id, 1)).rejects.toThrow(/nothing is owed/)
  })

  it('each donor collects their share into their own wallet', async () => {
    const before = await spendable(alice)
    const r = await as(alice).claimRepayments()
    expect(r).toMatchObject({ satoshis: 900 })
    expect(await spendable(alice)).toBeGreaterThan(before + 900 - 100) // minus the claim fee
    expect(await as(alice).claimRepayments()).toBeUndefined()
    expect((await as(bob).claimRepayments())?.satoshis).toBe(600)
  })

  it('milestone 2 can now be released', async () => {
    expect((await api().campaign(id)).milestones[1].approved).toBe(true)
    expect((await as(ngo).release(id)).milestone).toBe(2)
    const { spending } = await as(ngo).payPlanLine(id, 2, 'install', 5_000)
    expect(spending.ok).toBe(true)
  })
})

describe('an NGO that ignores its plan', () => {
  let id: string
  let donor: DonorAgent
  let memos: MemoBook

  it('a donor\'s autopilot agent backs it', async () => {
    id = (await as(careless).launch(input('Pumps for Machakos'))).campaignId
    memos = new MemoBook(memoryStore<Memo[]>([]))
    donor = new DonorAgent(parseMandate({
      name: 'Water', mode: 'autopilot', interests: 'water filters and pumps for schools', keywords: ['water', 'pumps'],
      budget: { totalSats: 20_000, perPledgeMaxSats: 10_000, perCreatorMaxPct: 100 }, requirements: { minRefundWindowDays: 7 }
    }), { api: new CryptoPledgePotApi(url, bob), client: as(bob), brain: new MockDonorBrain(), memos, chainTracker: chain.chainTracker, txExists: async () => true, now: () => clock, log: () => {} })
    expect((await donor.step()).pledged).toBe(1)
    const pledged = memos.all().find(m => m.kind === 'pledge')!
    expect(pledged.campaignId).toBe(id)
    const rest = 10_000 - pledged.amount!
    if (rest >= 100) await as(alice).donate((await api().campaign(id)).meta, rest)
  })

  it('after the report date and the grace period it is declared in breach and the breach goes on chain', async () => {
    clock += 3_601
    await as(careless).release(id)
    // The donor's agent never votes more money to an NGO that has not accounted for the last tranche.
    await as(careless).postUpdate(id, 2, 'All going well, 3 pumps installed, trust us.')
    await donor.step()
    expect(memos.all().find(m => m.kind === 'vote')).toMatchObject({ milestone: 2, vote: 'no', status: 'executed' })
    await agent.step()
    clock += 31 * DAY
    await agent.step()
    expect((await api().campaign(id)).status).toBe('funded')
    clock += 7 * DAY
    const s = await agent.step()
    expect(s.breaches).toBe(1)
    const c = await api().campaign(id)
    expect(c.status).toBe('breached')
    expect(c.milestones[1].pending).toMatch(/breached its payment plan/)
    const breach = agent.notices().find(n => n.kind === 'breach' && n.campaignId === id)!
    expect(breach.text).toMatch(/5,000 sats unaccounted/)
    expect(breach.txid).toMatch(/^[0-9a-f]{64}$/)
    expect(delivered.some(n => n.id === breach.id)).toBe(true)
    // The record is a plain OP_RETURN anyone can read.
    const anchored = await auditorAgent.listActions({ labels: [], includeOutputLockingScripts: true, includeOutputs: true, limit: 10 })
    const script = anchored.actions.find(a => a.txid === breach.txid)!.outputs!.find(o => o.satoshis === 0)!.lockingScript!
    expect(parseCryptoPledgePotRecord(script)).toMatchObject({ kind: 'breach', campaignId: id, record: { milestone: 1, unaccountedSats: 5_000 } })
    expect((await agent.step()).breaches).toBe(0) // announced once
  })

  it('the donor\'s agent reclaims the remaining escrow at once, co-signed by the arbiter', async () => {
    const before = await spendable(bob)
    expect((await donor.step()).refunds).toBe(1)
    const refund = memos.all().find(m => m.kind === 'refund')!
    expect(refund).toMatchObject({ status: 'executed', reasons: ['the NGO breached its payment plan'] })
    expect(await spendable(bob)).toBeGreaterThan(before)
    expect(Transaction.fromAtomicBEEF(Utils.toArray(await api().txBeef(refund.txid!), 'hex')).id('hex')).toBe(refund.txid)
  })
})
