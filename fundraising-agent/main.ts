/**
 * Run the CryptoPledgePot agent service (mainnet by default).
 *
 *   npm run agent                  # watch mode: one step every AGENT_INTERVAL_S (20 s)
 *   npm run agent -- --once        # a single step, then exit
 *   npm run agent -- --dry-run     # plan and log purchases without paying
 *
 * Needs: `npm run server` (CryptoPledgePot), `npm run data-provider` (the paid API), and
 * a few thousand sats in the agent's wallet for fees: use "Top up agent" on the
 * campaign page, or POST a BRC-29 payment to /api/agent/fund.
 *
 * Env (all optional):
 *   NETWORK=main|test  CRYPTOPLEDGEPOT_URL=http://localhost:8787  DATA_URL=http://localhost:8790
 *   AGENT_PORT=8791  AGENT_PUBLIC_URL=http://localhost:8791  AGENT_INTERVAL_S=20
 *   AGENT_ROOT_KEY (else data/agent.key)  AGENT_FEE_RESERVE=3000  AGENT_DEADLINE_MIN=15  AGENT_REFUND_DAYS=7
 *   The campaign terms (fundraising-agent/campaignPlan.ts): AGENT_READINGS=5 per milestone × AGENT_PRICE_CAP=50 sats
 *   + AGENT_FEE_ALLOWANCE=150 sats per milestone; the goal and the per-milestone cap are derived. AGENT_OPERATOR (who runs it).
 *   ANTHROPIC_API_KEY (Claude brain; without it the mock brain is used)  AGENT_MODEL  AGENT_BRAIN=mock
 */
import '../core/loadEnv'
import path from 'node:path'
import { CryptoPledgePot } from '../client/cryptoPledgePot'
import { CryptoPledgePotApi } from '../client/cryptoPledgePotApi'
import { ArcadeChainTracker, ARCADE_MAINNET, ARCADE_TESTNET } from '../client/arcadeChainTracker'
import { planCampaign } from './campaignPlan'
import { CryptoPledgePotAgent, type AgentConfig, type StepOutcome } from './agent'
import { defaultBrain } from './brain'
import { createActivityLog } from './activity'
import { createAgentApp } from './http'
import { fileStore, Ledger, type AgentState, type SpendEntry } from './ledger'
import { acquireLock } from '../shared/lock'
import { createCappedPayer } from './pay402'
import { createToolboxWallet, loadOrCreateKey } from '../shared/wallet'

const env = (k: string, d: string): string => process.env[k] ?? d
const num = (k: string, d: number): number => Number(process.env[k] ?? d)
const args = new Set(process.argv.slice(2))

async function main (): Promise<void> {
  const chain = env('NETWORK', 'main') === 'test' ? 'test' : 'main'
  const dataDir = path.resolve('data')
  acquireLock(path.join(dataDir, 'agent.lock')) // one agent per state: two would pay twice
  const setup = await createToolboxWallet({
    chain,
    rootKey: loadOrCreateKey('AGENT_ROOT_KEY', path.join(dataDir, 'agent.key')),
    dbFile: path.join(dataDir, 'agent-wallet.sqlite'),
    dbName: 'cryptopledgepot_agent'
  })
  const wallet = setup.wallet
  const api = new CryptoPledgePotApi(env('CRYPTOPLEDGEPOT_URL', 'http://localhost:8787'), wallet)
  const dataUrl = env('DATA_URL', 'http://localhost:8790')
  const port = num('AGENT_PORT', 8791)
  const now = Math.floor(Date.now() / 1000)
  const deadline = now + num('AGENT_DEADLINE_MIN', 15) * 60

  const mission = 'Map urban air quality across European cities and publish open reports for anyone to use.'
  // The terms come from one spending plan, so the goal, the milestones, the cap and the description agree.
  for (const k of ['AGENT_GOAL', 'AGENT_MAX_SPEND']) if (process.env[k] !== undefined) console.warn(`[agent] ${k} is ignored: the goal and the cap are derived from AGENT_READINGS × AGENT_PRICE_CAP + AGENT_FEE_ALLOWANCE`)
  const terms = planCampaign({ readingsPerMilestone: num('AGENT_READINGS', 5), pricePerReading: num('AGENT_PRICE_CAP', 50), feeAllowancePerMilestone: num('AGENT_FEE_ALLOWANCE', 150), operator: process.env.AGENT_OPERATOR })
  const config: AgentConfig = {
    mission,
    campaign: {
      title: 'AirWatch: an AI agent buying open air-quality data',
      description: terms.description,
      goal: terms.goal,
      deadline,
      refundAfter: deadline + num('AGENT_REFUND_DAYS', 7) * 86_400,
      milestones: terms.milestones,
      kind: 'agent',
      agentUrl: env('AGENT_PUBLIC_URL', `http://localhost:${port}`)
    },
    dataUrl,
    pricePerCall: num('AGENT_PRICE_CAP', 50),
    maxSpendPerMilestone: terms.maxSpendPerMilestone,
    feeReserve: num('AGENT_FEE_RESERVE', 3_000),
    dryRun: args.has('--dry-run')
  }

  const brain = defaultBrain()
  const ledger = new Ledger(fileStore<SpendEntry[]>(path.join(dataDir, 'agent-ledger.json'), []))
  const state = fileStore<AgentState>(path.join(dataDir, 'agent-state.json'), { worked: [] })
  const activity = createActivityLog()
  const agent = new CryptoPledgePotAgent(config, {
    log: activity.log,
    wallet,
    cryptopledgepot: new CryptoPledgePot(wallet, api),
    api,
    brain,
    ledger,
    state,
    pay: createCappedPayer({ wallet, allowedHosts: [new URL(dataUrl).host], maxPricePerCall: config.pricePerCall })
  })

  let last: StepOutcome | undefined
  const chainTracker = new ArcadeChainTracker(chain === 'main' ? ARCADE_MAINNET : ARCADE_TESTNET)
  createAgentApp({ wallet, ledger, state, chainTracker, mission, spendable: async () => await agent.spendable(), lastOutcome: () => last, activity: activity.recent, brainName: brain.name })
    .listen(port, () => console.log(`[agent] identity ${setup.identityKey} · brain ${brain.name} · status on http://localhost:${port}/api/agent`))

  const tick = async (): Promise<void> => {
    try { last = await agent.step() } catch (e) { console.error(`[agent] step failed: ${(e as Error).message}`) }
  }
  if (args.has('--once')) { await tick(); process.exit(0) }
  const interval = num('AGENT_INTERVAL_S', 20) * 1000
  for (;;) { await tick(); await new Promise(r => setTimeout(r, interval)) }
}

main().catch(e => { console.error(e); process.exit(1) })
