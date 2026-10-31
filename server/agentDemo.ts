/**
 * "AirWatch live": the agentic idea as a story you can watch.
 *
 * Everything is real code on wallet-toolbox's offline mock chain: the server,
 * the escrow contract, the paid data API (BRC-121), the AI agent with its
 * capped payer, and five backers using the same client as the browser. Only the
 * pace is staged: one beat every `paceMs`, and a virtual clock that jumps past
 * the deadline. Open the web app while it runs: the demo banner shows the
 * current beat, the live feed fills up, and the agent panel shows its activity.
 *
 * The data shop sells Zurich as "premium" at 500 sats, above the agent's 50-sat
 * cap, so the story shows the agent refusing to overpay.
 */
import type { Server } from 'node:http'
import { CryptoPledgePot } from '../client/cryptoPledgePot'
import { CryptoPledgePotApi } from '../client/cryptoPledgePotApi'
import { createMockChain, memoryKnex, type MockChain } from '../test/helpers/mockchain'
import { CryptoPledgePotAgent, type StepOutcome } from '../fundraising-agent/agent'
import { createActivityLog } from '../fundraising-agent/activity'
import { MockBrain, type Brain } from '../fundraising-agent/brain'
import { createDataProviderApp, serveDataProvider } from '../data-provider/dataProvider'
import { createAgentApp } from '../fundraising-agent/http'
import { Ledger, memoryStore, type AgentState, type SpendEntry } from '../fundraising-agent/ledger'
import { createCappedPayer } from '../fundraising-agent/pay402'
import { createCryptoPledgePotService } from './app'
import { CryptoPledgePotDb } from './db'

export interface DemoStatus {
  title: string
  step: number
  total: number
  text: string
  done: boolean
  error?: string
  campaignId?: string
}

export interface AgentDemoOptions {
  port?: number
  dataPort?: number
  agentPort?: number
  /** Pause after each beat (ms). 0 for tests. */
  paceMs?: number
  /** Public URL of the agent's status page (written into its campaign). */
  agentPublicUrl?: string
  brain?: Brain
  log?: (line: string) => void
}

export interface AgentDemo {
  url: string
  status: () => DemoStatus
  /** Resolves when the story is complete (rejects if a beat goes wrong). */
  done: Promise<void>
  ledger: Ledger
  /** The offline chain, for tests that inspect transactions. */
  chain: MockChain
  close: () => Promise<void>
}

const listen = async (app: { listen: (port: number, cb: () => void) => Server }, port: number): Promise<Server> =>
  await new Promise(resolve => { const s: Server = app.listen(port, () => resolve(s)) })
const portOf = (s: Server): number => (s.address() as { port: number }).port

export async function runAgentDemo (opts: AgentDemoOptions = {}): Promise<AgentDemo> {
  const log = opts.log ?? (line => console.log(`[demo] ${line}`))
  const paceMs = opts.paceMs ?? 6_000
  const status: DemoStatus = { title: 'AirWatch live', step: 0, total: 0, text: 'Setting up the offline world…', done: false }

  const chain = await createMockChain()
  const db = new CryptoPledgePotDb(memoryKnex())
  await db.migrate()
  let offset = 0
  const now = (): number => Math.floor(Date.now() / 1000) + offset
  const service = createCryptoPledgePotService({ wallet: await chain.makeWallet(), db, network: 'mock', chainTracker: chain.chainTracker, now, demoStatus: () => status })
  const server = await listen(service.app, opts.port ?? 8787)
  const url = `http://localhost:${portOf(server)}`

  // The paid data API: 50 sats per reading, Zurich "premium" at 500.
  const dataServer = await serveDataProvider(createDataProviderApp(await chain.makeWallet(), 50, { zurich: 500 }), opts.dataPort ?? 8790)
  const dataHost = `localhost:${portOf(dataServer)}`

  // The agent: its own wallet (a fee float), the capped payer, a visible activity log.
  const agentWallet = await chain.makeWallet()
  await chain.fund(agentWallet, 20_000)
  const activity = createActivityLog(60, line => log(`agent: ${line}`))
  const ledger = new Ledger(memoryStore<SpendEntry[]>([]))
  const state = memoryStore<AgentState>({ worked: [] })
  let last: StepOutcome | undefined
  const mission = 'Map urban air quality across European cities and publish open reports for anyone to use.'
  const agentServerApp = createAgentApp({ wallet: agentWallet, ledger, state, chainTracker: chain.chainTracker, mission, spendable: async () => await agent.spendable(), lastOutcome: () => last, activity: activity.recent })
  const agentServer = await listen(agentServerApp, opts.agentPort ?? 8791)
  const agentApi = new CryptoPledgePotApi(url, agentWallet)
  const start = now()
  const agent = new CryptoPledgePotAgent({
    mission,
    campaign: {
      title: 'AirWatch: an AI agent buying open air-quality data',
      description: 'I am an autonomous AI agent. Back me and I will buy air-quality readings from a pay-per-call data API, one BSV micropayment per reading, and publish a report for each milestone with a link to every payment. You only fund the next milestone after you have seen my report.',
      goal: 25_000,
      deadline: start + 3_600,
      refundAfter: start + 30 * 86_400,
      milestones: [{ title: 'First readings: 5 cities', percent: 30 }, { title: 'Full coverage: 10 cities', percent: 40 }, { title: 'Refresh and publish', percent: 30 }],
      kind: 'agent',
      agentUrl: opts.agentPublicUrl ?? `http://localhost:${portOf(agentServer)}`
    },
    dataUrl: `http://${dataHost}`,
    pricePerCall: 50,
    maxSpendPerMilestone: 250,
    feeReserve: 1_000
  }, {
    wallet: agentWallet,
    cryptopledgepot: new CryptoPledgePot(agentWallet, agentApi),
    api: agentApi,
    brain: opts.brain ?? new MockBrain(),
    ledger,
    state,
    log: activity.log,
    pay: createCappedPayer({ wallet: agentWallet, allowedHosts: [dataHost], maxPricePerCall: 50 })
  })

  // Five backers using the same client as the browser.
  const names = ['Ana', 'Ben', 'Chloe', 'Dev', 'Eli']
  const backers: Record<string, CryptoPledgePot> = {}
  for (const n of names) {
    const w = await chain.makeWallet()
    await chain.fund(w, 200_000)
    backers[n] = new CryptoPledgePot(w, new CryptoPledgePotApi(url, w))
  }

  const step = async (expect: StepOutcome['action']): Promise<StepOutcome> => {
    last = await agent.step()
    if (last.action !== expect) throw new Error(`expected the agent to be "${expect}", but it was "${last.action}"${'reason' in last ? `: ${last.reason}` : ''}`)
    return last
  }
  const meta = async () => (await new CryptoPledgePotApi(url).campaign(state.load().campaignId!)).meta
  const id = (): string => state.load().campaignId!

  const beats: Array<{ text: string, run: () => Promise<void> }> = [
    { text: 'An AI agent launches its own fundraising campaign: "AirWatch"', run: async () => { await step('launched'); status.campaignId = id() } },
    { text: 'Ana backs it with 12,000 sats', run: async () => { await backers.Ana.donate(await meta(), 12_000, { name: 'Ana', message: 'Curious what an agent does with this.' }) } },
    { text: 'Ben backs it with 6,000 sats', run: async () => { await backers.Ben.donate(await meta(), 6_000, { name: 'Ben' }) } },
    { text: 'Chloe sends a 1,000-sat micro-pledge', run: async () => { await backers.Chloe.donate(await meta(), 1_000, { name: 'Chloe', message: 'A tiny tip from a student 🙂' }) } },
    { text: 'Dev backs it with 8,000 sats', run: async () => { await backers.Dev.donate(await meta(), 8_000, { name: 'Dev', message: 'Open data FTW' }) } },
    { text: 'Eli backs it with 3,000 sats: the 25,000-sat goal is passed', run: async () => { await backers.Eli.donate(await meta(), 3_000, { name: 'Eli' }) } },
    { text: 'The deadline passes with the goal met: milestone 1 is approved', run: async () => { offset += 3_601 } },
    { text: 'The agent withdraws milestone 1 from escrow into its own wallet', run: async () => { await step('released') } },
    { text: 'The agent plans its purchases and pays the data API per call', run: async () => { await step('worked') } },
    { text: 'Backers vote on milestone 2 after reading the agent\'s report (Ben votes no)', run: async () => {
      await backers.Ana.vote(id(), 2, true); await backers.Ben.vote(id(), 2, false); await backers.Dev.vote(id(), 2, true)
    } },
    { text: 'Majority approves: the agent withdraws milestone 2', run: async () => { await step('released') } },
    { text: 'The agent buys more data, and refuses Zurich\'s 500-sat "premium" price', run: async () => { await step('worked') } },
    { text: 'Backers vote on the last milestone', run: async () => {
      await backers.Ana.vote(id(), 3, true); await backers.Chloe.vote(id(), 3, true); await backers.Eli.vote(id(), 3, true)
    } },
    { text: 'The agent withdraws the final milestone', run: async () => { await step('released') } },
    { text: 'The agent refreshes its readings and finishes the job', run: async () => { await step('worked') } },
    { text: 'Done: every sat went from backers to escrow to the agent to the data seller, all on chain', run: async () => { await step('stopped') } }
  ]
  status.total = beats.length

  const done = (async () => {
    for (const [i, beat] of beats.entries()) {
      status.step = i + 1
      status.text = beat.text
      log(`[${i + 1}/${beats.length}] ${beat.text}`)
      try { await beat.run() } catch (e) {
        status.error = (e as Error).message
        log(`beat failed: ${status.error}`)
        throw e
      }
      // Time passes between beats, and on a real chain so do blocks: mine one, so the agent's chain of
      // unconfirmed payments stays short (the wallet refuses BEEF ancestry deeper than 12).
      await chain.mineBlock()
      if (paceMs > 0) await new Promise(resolve => setTimeout(resolve, paceMs))
    }
    status.done = true
  })()

  return {
    url,
    status: () => status,
    done,
    ledger,
    chain,
    close: async () => {
      for (const s of [server, dataServer, agentServer]) await new Promise(resolve => s.close(resolve))
      await chain.close()
    }
  }
}
