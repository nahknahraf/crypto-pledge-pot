/**
 * Zero-click rehearsal: the whole story with ONLY agents, offline on the mock chain.
 *
 * Nobody approves anything. The fundraising agent launches its campaign; three donor agents in
 * AUTOPILOT (each with its own budget wallet) screen it, pledge, read each anchored report, verify it
 * and vote; the agent releases each milestone, buys data and reports; failed campaigns are reclaimed.
 * The only staged thing is the clock, which jumps past the deadline once the donors have had a look.
 *
 * Run it with the real brains before a mainnet run (`npm run rehearse:agents`, Claude when
 * ANTHROPIC_API_KEY is set): with real judgement, the donors may decline, and the story then ends
 * with a failed campaign and refunds. That outcome is reported, not hidden.
 */
import type { Server } from 'node:http'
import { Transaction } from '@bsv/sdk'
import { CryptoPledgePot } from '../client/cryptoPledgePot'
import { CryptoPledgePotApi } from '../client/cryptoPledgePotApi'
import { createMockChain, memoryKnex } from '../test/helpers/mockchain'
import { CryptoPledgePotAgent, type StepOutcome } from '../fundraising-agent/agent'
import { createActivityLog } from '../fundraising-agent/activity'
import type { Brain } from '../fundraising-agent/brain'
import { createDataProviderApp, serveDataProvider } from '../data-provider/dataProvider'
import { createAgentApp } from '../fundraising-agent/http'
import { Ledger, type AgentState, type SpendEntry } from '../fundraising-agent/ledger'
import { createCappedPayer } from '../fundraising-agent/pay402'
import { planCampaign } from '../fundraising-agent/campaignPlan'
import { DonorAgent } from '../donor-agent/donorAgent'
import type { DonorBrain } from '../donor-agent/brain'
import { parseMandate } from '../donor-agent/mandate'
import { MemoBook, type Memo } from '../donor-agent/memo'
import { memoryStore } from '../shared/store'
import { createCryptoPledgePotService } from './app'
import { CryptoPledgePotDb } from './db'

export interface RehearsalOptions {
  fundBrain: Brain
  donorBrain: DonorBrain
  log?: (line: string) => void
  /** Most agent rounds after the deadline before giving up. Default 12. */
  maxRounds?: number
}

export interface RehearsalResult {
  /** The campaign's final status: 'completed', 'failed', or where it got stuck. */
  status: string
  milestonesReleased: number
  raised: number
  /** Data purchases the fundraising agent made. */
  spent: { calls: number, sats: number }
  /** What each donor agent did, from its memos. */
  donors: Array<{ name: string, pledged: number, votes: string[], refunds: number, skipped: string[] }>
  /** Things a person had to do: always 0 (the point of the rehearsal). */
  humanActions: 0
}

const listen = async (app: { listen: (port: number, cb: () => void) => Server }): Promise<Server> =>
  await new Promise(resolve => { const s: Server = app.listen(0, () => resolve(s)) })
const portOf = (s: Server): number => (s.address() as { port: number }).port

export async function runRehearsal (o: RehearsalOptions): Promise<RehearsalResult> {
  const log = o.log ?? (line => console.log(line))
  const chain = await createMockChain()
  const db = new CryptoPledgePotDb(memoryKnex()); await db.migrate()
  let offset = 0
  const now = (): number => Math.floor(Date.now() / 1000) + offset
  const servers: Server[] = []
  try {
    const service = createCryptoPledgePotService({ wallet: await chain.makeWallet(), db, network: 'mock', chainTracker: chain.chainTracker, now })
    const server = await listen(service.app); servers.push(server)
    const url = `http://localhost:${portOf(server)}`
    const dataServer = await serveDataProvider(createDataProviderApp(await chain.makeWallet(), 50, { zurich: 500 }), 0); servers.push(dataServer)
    const dataHost = `localhost:${portOf(dataServer)}`

    // The fundraising agent, exactly as in production: its own wallet, capped payer, public status page.
    const agentWallet = await chain.makeWallet(); await chain.fund(agentWallet, 20_000)
    const activity = createActivityLog(200, line => log(`  [fundraising agent] ${line}`))
    const ledger = new Ledger(memoryStore<SpendEntry[]>([]))
    const state = memoryStore<AgentState>({ worked: [] })
    let last: StepOutcome | undefined
    const mission = 'Map urban air quality across European cities and publish open reports for anyone to use.'
    const agentServer = await listen(createAgentApp({ wallet: agentWallet, ledger, state, chainTracker: chain.chainTracker, mission, spendable: async () => await agent.spendable(), lastOutcome: () => last, activity: activity.recent, brainName: o.fundBrain.name })); servers.push(agentServer)
    const agentApi = new CryptoPledgePotApi(url, agentWallet)
    const start = now()
    const terms = planCampaign({ readingsPerMilestone: 5, pricePerReading: 50, feeAllowancePerMilestone: 150, operator: process.env.AGENT_OPERATOR })
    const agent = new CryptoPledgePotAgent({
      mission,
      campaign: {
        title: 'AirWatch: an AI agent buying open air-quality data',
        description: terms.description,
        goal: terms.goal,
        deadline: start + 3_600,
        refundAfter: start + 30 * 86_400,
        milestones: terms.milestones,
        kind: 'agent',
        agentUrl: `http://localhost:${portOf(agentServer)}`
      },
      dataUrl: `http://${dataHost}`,
      pricePerCall: 50,
      maxSpendPerMilestone: terms.maxSpendPerMilestone,
      feeReserve: 1_000
    }, {
      wallet: agentWallet, cryptopledgepot: new CryptoPledgePot(agentWallet, agentApi), api: agentApi, brain: o.fundBrain,
      ledger, state, log: activity.log, pay: createCappedPayer({ wallet: agentWallet, allowedHosts: [dataHost], maxPricePerCall: 50 })
    })

    // Three donor agents in AUTOPILOT, each with its own budget wallet. Nobody approves their pledges or votes.
    const storage = (chain.services as any).storage
    const txExists = async (txid: string): Promise<boolean> => (await storage.getTransaction(txid)) != null
    const fetchTx = async (txid: string): Promise<Transaction | undefined> => {
      const row = await storage.getTransaction(txid)
      if (row == null) return undefined
      let proof = await (chain.services as any).getMerklePath(txid)
      if (proof.merklePath === undefined) { await chain.mineBlock(); proof = await (chain.services as any).getMerklePath(txid) }
      const tx = Transaction.fromBinary(Array.from(row.rawTx as number[]))
      tx.merklePath = proof.merklePath
      return tx
    }
    const donors: Array<{ name: string, agent: DonorAgent, memos: MemoBook }> = []
    for (const [name, interests] of [
      ['Open-data donor', 'open environmental data, air quality monitoring, public datasets'],
      ['Climate donor', 'climate and air pollution research with transparent spending'],
      ['AI-transparency donor', 'AI agents that publish every payment and stay within published limits']
    ] as const) {
      const w = await chain.makeWallet(); await chain.fund(w, 40_000)
      const memos = new MemoBook(memoryStore<Memo[]>([]))
      const mandate = parseMandate({ name, mode: 'autopilot', interests, keywords: ['air', 'data', 'agent'], budget: { totalSats: 4_000, perPledgeMaxSats: 1_000, perCreatorMaxPct: 50 } })
      donors.push({ name, memos, agent: new DonorAgent(mandate, { api: new CryptoPledgePotApi(url, w), client: new CryptoPledgePot(w, new CryptoPledgePotApi(url, w)), brain: o.donorBrain, memos, chainTracker: chain.chainTracker, txExists, fetchTx, now, log: line => log(`  [${name}] ${line}`) }) })
    }

    const campaign = async () => (await new CryptoPledgePotApi(url).campaign(state.load().campaignId!))
    const agentStep = async (): Promise<StepOutcome> => { last = await agent.step(); log(`fundraising agent: ${last.action}${'reason' in last && last.reason !== undefined ? ` (${last.reason})` : ''}`); return last }
    const donorsStep = async (): Promise<void> => {
      for (const d of donors) {
        const s = await d.agent.step()
        if (s.pledged + s.votes + s.refunds + s.skipped > 0) log(`${d.name}: pledged ${s.pledged}, voted ${s.votes}, reclaimed ${s.refunds}, skipped ${s.skipped}`)
      }
    }

    log('1. The fundraising agent launches its campaign; the donor agents screen it and decide by themselves.')
    await agentStep()
    await donorsStep()
    log(`   raised ${(await campaign()).raised.toLocaleString('en-US')} of ${terms.goal.toLocaleString('en-US')} sats`)
    log('2. The deadline passes (the clock jumps). From here every agent just keeps taking its next step.')
    offset += 3_601
    for (let round = 1; round <= (o.maxRounds ?? 12); round++) {
      const out = await agentStep()
      await donorsStep()
      await chain.mineBlock()
      const c = await campaign()
      if (out.action === 'stopped' || c.status === 'completed' || c.status === 'failed') break
    }
    const c = await campaign()
    const result: RehearsalResult = {
      status: c.status,
      milestonesReleased: c.milestonesReleased,
      raised: c.raised,
      spent: ledger.totals(),
      donors: donors.map(d => {
        const ms = d.memos.all()
        return {
          name: d.name,
          pledged: ms.filter(m => m.kind === 'pledge' && m.status === 'executed').reduce((t, m) => t + (m.amount ?? 0), 0),
          votes: ms.filter(m => m.kind === 'vote').map(m => `m${m.milestone}:${m.vote ?? m.status}`),
          refunds: ms.filter(m => m.kind === 'refund' && m.status === 'executed').length,
          skipped: ms.filter(m => m.kind === 'skip').map(m => `${m.campaignTitle}: ${m.reasons[0] ?? m.summary}${m.score !== undefined ? ` [${m.score.parts.map(p => `${p.name} ${p.points}/${p.max}${p.name === 'risk flags' ? ` (${p.why})` : ''}`).join('; ')}]` : ''}`)
        }
      }),
      humanActions: 0
    }
    log(`3. Result: campaign ${result.status}, ${result.milestonesReleased}/3 milestones released, ${result.raised.toLocaleString('en-US')} sats raised, ${result.spent.calls} data purchases (${result.spent.sats} sats). Human actions: 0.`)
    return result
  } finally {
    for (const s of servers) await new Promise(resolve => s.close(resolve))
    await chain.close()
  }
}
