/**
 * Run your routine agent: npm run routine-agent
 *
 * It executes the giving routines you delegated to it ("Automatic" on the
 * Giving routines page), from a budget you move into its own wallet. Run it on
 * your own machine: its API listens on 127.0.0.1 only.
 *
 * Env: CRYPTOPLEDGEPOT_URL (http://localhost:8787), NETWORK=main|test,
 *      ROUTINE_AGENT_PORT (8793, bound to 127.0.0.1), ROUTINE_AGENT_INTERVAL_S (60),
 *      ROUTINE_AGENT_MAX_SATS_PER_ROUND (1000000), ROUTINE_AGENT_ROOT_KEY
 *      (else data/routine-agent.key, generated once).
 */
import path from 'node:path'
import { CryptoPledgePot } from '../client/cryptoPledgePot'
import { CryptoPledgePotApi } from '../client/cryptoPledgePotApi'
import { ArcadeChainTracker, ARCADE_MAINNET, ARCADE_TESTNET } from '../client/arcadeChainTracker'
import { fileStore } from './ledger'
import { RoutineAgent, type RoutineAgentState, type RoutineStepSummary } from './routineAgent'
import { createRoutineAgentApp } from './routineAgentHttp'
import { createToolboxWallet, loadOrCreateKey } from './wallet'

const network = process.env.NETWORK === 'test' ? 'test' : 'main'
const dataDir = path.resolve('data')
const serverUrl = process.env.CRYPTOPLEDGEPOT_URL ?? 'http://localhost:8787'

const health = await (await fetch(`${serverUrl}/api/health`)).json()
if (health.network === 'mock') {
  // A real wallet must never pay into simulated campaigns. The page simulates automatic runs itself in the demo.
  console.error('The server is the offline demo (network "mock"): the routine agent pays with a real wallet and refuses to run against it.')
  process.exit(1)
}

const setup = await createToolboxWallet({
  chain: network,
  rootKey: loadOrCreateKey('ROUTINE_AGENT_ROOT_KEY', path.join(dataDir, 'routine-agent.key')),
  dbFile: path.join(dataDir, 'routine-agent-wallet.sqlite'),
  dbName: 'cryptopledgepot_routine_agent'
})
const wallet = setup.wallet
const api = new CryptoPledgePotApi(serverUrl, wallet)
const balance = async (): Promise<number> => {
  const { outputs } = await wallet.listOutputs({ basket: 'default', limit: 1000 })
  return outputs.filter(o => o.spendable).reduce((sum, o) => sum + o.satoshis, 0)
}
const agent = new RoutineAgent({
  api,
  client: new CryptoPledgePot(wallet, api),
  balance,
  state: fileStore<RoutineAgentState>(path.join(dataDir, 'routine-agent.json'), { ownerIdentityKey: null, activity: [] }),
  maxSatsPerStep: Number(process.env.ROUTINE_AGENT_MAX_SATS_PER_ROUND ?? 1_000_000),
  log: console.log
})

let last: RoutineStepSummary | undefined
let running = false
const runStep = async (): Promise<RoutineStepSummary> => {
  if (running) return last ?? { delegated: 0, due: 0, paid: 0, skipped: 0, failed: 0, sats: 0 }
  running = true
  try { last = await agent.step(); return last } finally { running = false }
}

const port = Number(process.env.ROUTINE_AGENT_PORT ?? 8793)
const chainTracker = new ArcadeChainTracker(network === 'main' ? ARCADE_MAINNET : ARCADE_TESTNET)
const identityKey = (await wallet.getPublicKey({ identityKey: true })).publicKey
const startBalance = await balance()
createRoutineAgentApp({ agent, wallet, chainTracker, lastStep: () => last, runStep }).listen(port, '127.0.0.1', () => {
  console.log(`[routines] agent ${identityKey} · ${network} · budget ${startBalance} sats · http://127.0.0.1:${port}/api/routine-agent`)
})

const intervalMs = Number(process.env.ROUTINE_AGENT_INTERVAL_S ?? 60) * 1000
for (;;) {
  try { const s = await runStep(); if (s.due > 0) console.log(`[routines] round: ${JSON.stringify(s)}`) } catch (e) { console.error(`[routines] round failed: ${(e as Error).message}`) }
  await new Promise(resolve => setTimeout(resolve, intervalMs))
}
