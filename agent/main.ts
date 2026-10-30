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
 *   AGENT_ROOT_KEY (else data/agent.key)  AGENT_PRICE_CAP=50  AGENT_MAX_SPEND=500
 *   AGENT_FEE_RESERVE=3000  AGENT_GOAL=20000  AGENT_DEADLINE_MIN=15  AGENT_REFUND_DAYS=7
 *   ANTHROPIC_API_KEY (Claude brain; without it the mock brain is used)  AGENT_MODEL  AGENT_BRAIN=mock
 */
import path from 'node:path'
import { CryptoPledgePot } from '../client/cryptoPledgePot'
import { CryptoPledgePotApi } from '../client/cryptoPledgePotApi'
import { ArcadeChainTracker, ARCADE_MAINNET, ARCADE_TESTNET } from '../client/arcadeChainTracker'
import { CryptoPledgePotAgent, type AgentConfig, type StepOutcome } from './agent'
import { defaultBrain } from './brain'
import { createActivityLog } from './activity'
import { createAgentApp } from './http'
import { fileStore, Ledger, type AgentState, type SpendEntry } from './ledger'
import { createCappedPayer } from './pay402'
import { createToolboxWallet, loadOrCreateKey } from './wallet'

const env = (k: string, d: string): string => process.env[k] ?? d
const num = (k: string, d: number): number => Number(process.env[k] ?? d)
const args = new Set(process.argv.slice(2))

async function main (): Promise<void> {
  const chain = env('NETWORK', 'main') === 'test' ? 'test' : 'main'
  const dataDir = path.resolve('data')
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
  const config: AgentConfig = {
    mission,
    campaign: {
      title: 'AirWatch: an AI agent buying open air-quality data',
      description: 'I am an autonomous AI agent. Back me and I will buy air-quality readings from a pay-per-call data API, ' +
        'one BSV micropayment per reading, and publish a report for each milestone with a link to every payment. ' +
        'You only fund the next milestone after you have seen my report.',
      goal: num('AGENT_GOAL', 20_000),
      deadline,
      refundAfter: deadline + num('AGENT_REFUND_DAYS', 7) * 86_400,
      milestones: [{ title: 'First readings: 5 cities', percent: 40 }, { title: 'Full coverage: 10 cities', percent: 60 }],
      kind: 'agent',
      agentUrl: env('AGENT_PUBLIC_URL', `http://localhost:${port}`)
    },
    dataUrl,
    pricePerCall: num('AGENT_PRICE_CAP', 50),
    maxSpendPerMilestone: num('AGENT_MAX_SPEND', 500),
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
  createAgentApp({ wallet, ledger, state, chainTracker, mission, spendable: async () => await agent.spendable(), lastOutcome: () => last, activity: activity.recent })
    .listen(port, () => console.log(`[agent] identity ${setup.identityKey} · brain ${brain.name} · status on http://localhost:${port}/api/agent`))

  const tick = async (): Promise<void> => {
    try { last = await agent.step() } catch (e) { console.error(`[agent] step failed: ${(e as Error).message}`) }
  }
  if (args.has('--once')) { await tick(); process.exit(0) }
  const interval = num('AGENT_INTERVAL_S', 20) * 1000
  for (;;) { await tick(); await new Promise(r => setTimeout(r, interval)) }
}

main().catch(e => { console.error(e); process.exit(1) })
