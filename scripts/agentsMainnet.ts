/**
 * npm run agents:mainnet: the zero-click run. Starts the server, the data provider, the fundraising agent and
 * three autopilot donor agents (scripts/zeroClick.ts), then the team treasury: ONE deposit to the address it
 * prints funds every agent, and from then on nobody clicks or approves anything. Ctrl+C stops everything.
 *
 * Mainnet by default (NETWORK=test for testnet). Real sats: about 7,500 in total. Check first with
 * `npm run rehearse:agents` (offline, same agents and brains). Needs ANTHROPIC_API_KEY for Claude brains.
 */
import '../core/loadEnv'
import { spawn, type ChildProcess } from 'node:child_process'
import { donorDir, ensureDonorMandate, ZERO_CLICK } from './zeroClick'
import { runTreasury } from './treasuryRun'

const network = process.env.NETWORK === 'test' ? 'test' : 'main'
const dataRoot = process.env.CPP_DATA_DIR ?? 'data' // every process gets it through the environment
const children: ChildProcess[] = []
const start = (label: string, script: string, env: Record<string, string>): void => {
  const p = spawn('npm', ['run', '-s', script], { env: { ...process.env, NETWORK: network, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  const prefix = (d: Buffer): void => { for (const line of String(d).split('\n')) if (line.trim() !== '') console.log(`[${label}] ${line}`) }
  p.stdout.on('data', prefix); p.stderr.on('data', prefix)
  p.on('exit', code => console.log(`[${label}] exited (${code})`))
  children.push(p)
}
const stopAll = (): void => { for (const c of children) c.kill('SIGTERM'); process.exit(0) }
process.on('SIGINT', stopAll); process.on('SIGTERM', stopAll)

const up = async (url: string, what: string): Promise<void> => {
  for (let i = 0; i < 120; i++) { if (await fetch(url).then(r => r.ok, () => false)) return; await new Promise(r => setTimeout(r, 1000)) }
  throw new Error(`${what} did not come up at ${url}`)
}

console.log(`Zero-click run on BSV ${network}net: server, data provider, fundraising agent, ${ZERO_CLICK.donors.length} autopilot donor agents, team treasury.`)
start('server', 'server', { PORT: String(ZERO_CLICK.serverPort) })
start('data', 'data-provider', { DATA_PORT: String(ZERO_CLICK.dataPort) })
await up(`http://127.0.0.1:${ZERO_CLICK.serverPort}/api/health`, 'the server')
start('fundraising', 'agent', { AGENT_PORT: String(ZERO_CLICK.agentPort), AGENT_FEE_RESERVE: String(ZERO_CLICK.agentFeeReserve), AGENT_INTERVAL_S: '20', CRYPTOPLEDGEPOT_URL: `http://127.0.0.1:${ZERO_CLICK.serverPort}`, DATA_URL: `http://127.0.0.1:${ZERO_CLICK.dataPort}` })
for (const d of ZERO_CLICK.donors) {
  start(d.slug, 'donor', { DONOR_DATA_DIR: donorDir(d, dataRoot), DONOR_MANDATE: ensureDonorMandate(d, dataRoot), DONOR_PORT: String(d.port), DONOR_INTERVAL_S: '30', CRYPTOPLEDGEPOT_URL: `http://127.0.0.1:${ZERO_CLICK.serverPort}` })
}
await up(`http://127.0.0.1:${ZERO_CLICK.agentPort}/api/agent`, 'the fundraising agent')
for (const d of ZERO_CLICK.donors) await up(`http://127.0.0.1:${d.port}/api/donor`, d.name)
await runTreasury({ network })
console.log('Funded. The agents now run by themselves: the campaign, pledges, purchases, reports, votes, releases. Ctrl+C to stop.')
