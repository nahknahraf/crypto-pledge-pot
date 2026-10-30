/**
 * Step 3: the agent service end to end, offline. Real wallet-toolbox wallets on
 * the mock chain (every script validated), the CryptoPledgePot server over HTTP, a
 * separate paid data provider, human backers, and the agent with the mock brain.
 *
 *   agent launches → humans back it → deadline → agent releases M1 →
 *   agent buys data (402 micropayments) → reports → backers vote → M2 → done
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import { Transaction } from '@bsv/sdk'
import type { Wallet } from '@bsv/wallet-toolbox'
import { CryptoPledgePot } from '../client/cryptoPledgePot'
import { CryptoPledgePotApi } from '../client/cryptoPledgePotApi'
import { createCryptoPledgePotApp } from '../server/app'
import { CryptoPledgePotDb } from '../server/db'
import { CryptoPledgePotAgent, type AgentConfig } from '../agent/agent'
import { MockBrain, sanitizePlan, type Brain } from '../agent/brain'
import { createDataProviderApp, serveDataProvider } from '../agent/dataProvider'
import { Ledger, memoryStore, type AgentState, type SpendEntry } from '../agent/ledger'
import { createCappedPayer, PaidButNotServed } from '../agent/pay402'
import { createMockChain, memoryKnex, type MockChain } from './helpers/mockchain'

const T0 = Math.floor(Date.now() / 1000) - 30 * 86_400
let clock = T0
let chain: MockChain
let cryptopledgepotServer: Server, dataServer: Server, greedyServer: Server
let url: string, dataHost: string, greedyHost: string
let provider: Wallet, greedyProvider: Wallet

const spendable = async (w: Wallet): Promise<number> =>
  (await w.listOutputs({ basket: 'default', limit: 1000 })).outputs.filter(o => o.spendable).reduce((s, o) => s + o.satoshis, 0)
const listen = async (app: any): Promise<[Server, string]> => await new Promise(resolve => {
  const s = app.listen(0, () => resolve([s, `127.0.0.1:${(s.address() as any).port}`]))
})
const as = (w: Wallet): CryptoPledgePot => new CryptoPledgePot(w, new CryptoPledgePotApi(url, w))

function makeAgent (wallet: Wallet, overrides: Partial<AgentConfig> = {}, brain: Brain = new MockBrain()) {
  const ledger = new Ledger(memoryStore<SpendEntry[]>([]))
  const state = memoryStore<AgentState>({ worked: [] })
  const logs: string[] = []
  const config: AgentConfig = {
    mission: 'Map urban air quality across European cities for an open dataset',
    campaign: {
      title: 'AirWatch agent: open air-quality reports',
      description: 'An AI agent service that buys air-quality readings and publishes reports.',
      goal: 20_000,
      deadline: T0 + 3_600,
      refundAfter: T0 + 30 * 3_600,
      milestones: [{ title: 'First city readings', percent: 40 }, { title: 'Wider coverage', percent: 60 }]
    },
    dataUrl: `http://${dataHost}`,
    pricePerCall: 50,
    maxSpendPerMilestone: 150, // 3 calls
    feeReserve: 1_000,
    ...overrides
  }
  const agent = new CryptoPledgePotAgent(config, {
    wallet,
    cryptopledgepot: as(wallet),
    api: new CryptoPledgePotApi(url, wallet),
    brain,
    ledger,
    state,
    pay: createCappedPayer({ wallet, allowedHosts: [dataHost], maxPricePerCall: 50 }),
    log: l => logs.push(l)
  })
  return { agent, ledger, state, logs, config }
}

beforeAll(async () => {
  chain = await createMockChain()
  const arbiter = await chain.makeWallet()
  provider = await chain.makeWallet()
  greedyProvider = await chain.makeWallet()
  const db = new CryptoPledgePotDb(memoryKnex())
  await db.migrate()
  ;[cryptopledgepotServer, url] = await listen(createCryptoPledgePotApp({ wallet: arbiter, db, chainTracker: chain.chainTracker, now: () => clock }))
  url = `http://${url}`
  dataServer = await serveDataProvider(createDataProviderApp(provider, 50), 0, '127.0.0.1')
  dataHost = `127.0.0.1:${(dataServer.address() as any).port}`
  greedyServer = await serveDataProvider(createDataProviderApp(greedyProvider, 5_000), 0, '127.0.0.1')
  greedyHost = `127.0.0.1:${(greedyServer.address() as any).port}`
})

afterAll(async () => {
  for (const s of [cryptopledgepotServer, dataServer, greedyServer]) await new Promise(r => s?.close(r))
  await chain?.close()
})

describe('an AI agent service funded through CryptoPledgePot', () => {
  let agentWallet: Wallet, alice: Wallet, bob: Wallet
  let a: ReturnType<typeof makeAgent>
  let campaignId: string

  it('the agent launches its own fundraising campaign', async () => {
    agentWallet = await chain.makeWallet()
    alice = await chain.makeWallet()
    bob = await chain.makeWallet()
    for (const w of [agentWallet, alice, bob]) await chain.fund(w, 100_000)
    clock = T0
    a = makeAgent(agentWallet)
    const out = await a.agent.step()
    expect(out.action).toBe('launched')
    campaignId = (out as any).campaignId
    expect(a.state.load().campaignId).toBe(campaignId)
    const view = await new CryptoPledgePotApi(url).campaign(campaignId)
    expect(view.meta.creatorIdentityKey).toBe(agentWallet.identityKey)
  })

  it('waits while humans back it', async () => {
    const { meta } = await new CryptoPledgePotApi(url).campaign(campaignId)
    await as(alice).donate(meta, 15_000, { name: 'Alice', message: 'Open data, yes please' })
    await as(bob).donate(meta, 10_000, { name: 'Bob' })
    expect(await a.agent.step()).toMatchObject({ action: 'waiting' })
  })

  it('after the deadline it withdraws milestone 1 into its own wallet', async () => {
    clock = T0 + 3_601
    const before = await a.agent.spendable()
    const out = await a.agent.step()
    expect(out).toMatchObject({ action: 'released', milestone: 1, sats: 10_000 }) // 40% of 25,000
    const txid = (out as any).txids[0]
    const p = (await new CryptoPledgePotApi(url).campaign(campaignId)).feed[0]
    const tx = Transaction.fromAtomicBEEF(Array.from(Buffer.from((await new CryptoPledgePotApi(url).pledge(p.id)).beef, 'hex')))
    expect(tx.id('hex')).toBe(txid)
    expect((await a.agent.spendable()) - before).toBe(10_000 - tx.getFee())
  })

  it('spends the budget on paid API calls, within its cap, and logs every payment', async () => {
    const before = await spendable(provider)
    const out = await a.agent.step()
    expect(out).toMatchObject({ action: 'worked', milestone: 1, calls: 3, sats: 150, updatePosted: true })
    expect(await spendable(provider)).toBe(before + 150)
    const entries = a.ledger.forMilestone(1)
    expect(entries).toHaveLength(3)
    expect(entries.every(e => /^[0-9a-f]{64}$/.test(e.txid ?? '') && e.sats === 50)).toBe(true)
    // Its report is now the progress update backers vote on.
    const m2 = (await new CryptoPledgePotApi(url).campaign(campaignId)).milestones[1]
    expect(m2.update?.note).toMatch(/3 readings bought for 150 sats/)
    expect(m2.update?.note).toContain(`https://whatsonchain.com/tx/${entries[0].txid!}`)
  })

  it('does not spend twice for the same milestone', async () => {
    expect(await a.agent.step()).toMatchObject({ action: 'waiting' })
    expect(a.ledger.all()).toHaveLength(3)
  })

  it('backers approve; the agent releases milestone 2, works, and finishes', async () => {
    await as(alice).vote(campaignId, 2, true)
    expect(await a.agent.step()).toMatchObject({ action: 'released', milestone: 2, sats: 15_000 })
    const worked = await a.agent.step()
    expect(worked).toMatchObject({ action: 'worked', milestone: 2, calls: 3, updatePosted: false })
    expect(new Set(a.ledger.all().map(e => e.topic)).size).toBe(6) // fresh cities each round
    expect(await a.agent.step()).toMatchObject({ action: 'stopped' })
    expect((await new CryptoPledgePotApi(url).campaign(campaignId)).status).toBe('completed')
  })
})

describe('the agent cannot be talked into overspending', () => {
  it('a greedy brain asking for 10 calls is held to the budget', async () => {
    const wallet = await chain.makeWallet()
    await chain.fund(wallet, 20_000)
    const greedyBrain: Brain = {
      name: 'greedy',
      planCalls: async () => sanitizePlan(['munich', 'berlin', 'paris', 'madrid', 'rome', 'vienna', 'zurich', 'amsterdam', 'warsaw', 'prague'].map(topic => ({ topic, why: 'more!' })), 10),
      writeReport: async () => 'report'
    }
    const { agent, ledger, state } = makeAgent(wallet, { maxSpendPerMilestone: 100 }, greedyBrain)
    state.save({ campaignId: 'x', worked: [] })
    // Drive work() directly through a minimal campaign view.
    const view: any = { id: 'x', meta: { milestones: [{ title: 'only', percent: 100 }] }, milestones: [{ index: 1, title: 'only', released: true }] }
    const out = await (agent as any).work(view, 1)
    expect(out).toMatchObject({ action: 'worked', calls: 2, sats: 100 })
    expect(ledger.all()).toHaveLength(2)
  })

  it('a paid call that delivers nothing is recorded, counts against the cap, and is not paid twice', async () => {
    const wallet = await chain.makeWallet()
    await chain.fund(wallet, 20_000)
    const { agent, ledger, state } = makeAgent(wallet) // cap 150 = 3 calls
    let n = 0
    ;(agent as any).deps.pay = async (url: string) => {
      if (n++ === 0) throw new PaidButNotServed(`${url}: paid 50 sats but got HTTP 500`, 50, 'ab'.repeat(32))
      return { body: { city: 'x', aqi: 1 }, paid: 50, txid: 'cd'.repeat(32) }
    }
    state.save({ campaignId: 'x', worked: [] })
    const view: any = { id: 'x', meta: { milestones: [{ title: 'only', percent: 100 }] }, milestones: [{ index: 1, title: 'only', released: true }] }
    await (agent as any).work(view, 1)
    expect(ledger.all().map(e => e.failed === true)).toEqual([true, false, false])
    expect(ledger.totals().sats).toBe(150)
    // A second run for the same milestone (a restart, a failed step) finds the cap already used.
    await (agent as any).work(view, 1)
    expect(ledger.forMilestone(1).reduce((t, e) => t + e.sats, 0)).toBe(150)
  })

  it('an overpriced or unlisted API is refused, and nothing is paid', async () => {
    const wallet = await chain.makeWallet()
    await chain.fund(wallet, 20_000)
    const { agent, ledger, state, logs } = makeAgent(wallet, { dataUrl: `http://${greedyHost}` })
    state.save({ campaignId: 'x', worked: [] })
    const before = await spendable(wallet)
    const view: any = { id: 'x', meta: { milestones: [{ title: 'only', percent: 100 }] }, milestones: [{ index: 1, title: 'only', released: true }] }
    const out = await (agent as any).work(view, 1)
    expect(out).toMatchObject({ action: 'worked', calls: 0, sats: 0 })
    expect(ledger.all()).toHaveLength(0)
    expect(await spendable(wallet)).toBe(before)
    expect(logs.some(l => /refused to pay: .*allow-list/.test(l))).toBe(true)
  })
})

describe('an underfunded agent campaign', () => {
  it('stops, gets nothing, and backers reclaim their pledges', async () => {
    const wallet = await chain.makeWallet()
    const carol = await chain.makeWallet()
    for (const w of [wallet, carol]) await chain.fund(w, 50_000)
    clock = T0
    const { agent, state } = makeAgent(wallet, { campaign: { title: 'Underfunded agent', description: '', goal: 1_000_000, deadline: T0 + 3_600, refundAfter: T0 + 7_200, milestones: [{ title: 'All', percent: 100 }] } })
    await agent.step()
    const { meta } = await new CryptoPledgePotApi(url).campaign(state.load().campaignId!)
    const p = await as(carol).donate(meta, 5_000)
    clock = T0 + 3_601
    const before = await agent.spendable()
    expect(await agent.step()).toMatchObject({ action: 'stopped' })
    expect(await agent.spendable()).toBe(before)
    const r = await as(carol).refund(p.id, 'failed', clock)
    expect(r.satoshis).toBe(5_000)
  })
})

describe('restart safety', () => {
  it('a restarted agent picks up mid-milestone without withdrawing or spending twice', async () => {
    const wallet = await chain.makeWallet()
    const backer = await chain.makeWallet()
    for (const w of [wallet, backer]) await chain.fund(w, 100_000)
    clock = T0
    const first = makeAgent(wallet, { campaign: { title: 'Restart check agent', description: 'Agent that gets restarted.', goal: 5_000, deadline: T0 + 3_600, refundAfter: T0 + 30 * 3_600, milestones: [{ title: 'Readings', percent: 50 }, { title: 'More readings', percent: 50 }] } })
    await first.agent.step() // launch
    const { meta } = await new CryptoPledgePotApi(url).campaign(first.state.load().campaignId!)
    await as(backer).donate(meta, 6_000)
    clock = T0 + 3_601
    expect(await first.agent.step()).toMatchObject({ action: 'released', milestone: 1 })

    // The process dies here. A new one starts with the same saved state and ledger.
    const restarted = new CryptoPledgePotAgent(first.config, { ...first.agent.deps })
    expect(await restarted.step()).toMatchObject({ action: 'worked', milestone: 1 }) // continues: spends, does not withdraw again
    const spent = first.ledger.all().length
    expect(spent).toBeGreaterThan(0)
    const again = new CryptoPledgePotAgent(first.config, { ...first.agent.deps })
    expect(await again.step()).toMatchObject({ action: 'waiting' }) // milestone 1 already worked
    expect(first.ledger.all().length).toBe(spent)
    expect((await new CryptoPledgePotApi(url).campaign(first.state.load().campaignId!)).milestones[0].releaseTxids).toHaveLength(1)
  })
})
