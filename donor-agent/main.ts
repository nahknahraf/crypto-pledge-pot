/**
 * Run your donor agent: npm run donor
 *
 * Reads your terms from data/donor-mandate.json (start from
 * donor-mandate.example.json). Mode comes from the file:
 *  - copilot:   no wallet here. The agent proposes; you approve and pay from
 *               your BSV Desktop on the "My donor agent" page.
 *  - autopilot: the agent gets its own wallet (data/donor.key). Move your
 *               budget into it ("Top up budget" on the page, or POST a BRC-29
 *               payment to /api/donor/fund) and it does the rest.
 *
 * Env: CRYPTOPLEDGEPOT_URL (http://localhost:8787), NETWORK=main|test,
 *      DONOR_PORT (8792), DONOR_HOST (127.0.0.1; 0.0.0.0 inside Docker), DONOR_INTERVAL_S (60),
 *      DONOR_DATA_DIR (data: its key, wallet, memos and lock; one per agent),
 *      DONOR_MANDATE (<DONOR_DATA_DIR>/donor-mandate.json), ANTHROPIC_API_KEY (Claude;
 *      otherwise a deterministic brain), DONOR_ROOT_KEY.
 */
import '../core/loadEnv'
import fs from 'node:fs'
import { Transaction, Utils, type WalletInterface } from '@bsv/sdk'
import path from 'node:path'
import { CryptoPledgePot, wocBeef } from '../client/cryptoPledgePot'
import { CryptoPledgePotApi } from '../client/cryptoPledgePotApi'
import { ArcadeChainTracker, ARCADE_MAINNET, ARCADE_TESTNET } from '../client/arcadeChainTracker'
import { fileStore } from '../shared/store'
import { acquireLock } from '../shared/lock'
import { createToolboxWallet, loadOrCreateKey } from '../shared/wallet'
import { defaultDonorBrain } from './brain'
import { DonorAgent, type StepSummary } from './donorAgent'
import { createDonorApp } from './http'
import { parseMandate } from './mandate'
import { MemoBook, type Memo } from './memo'

const network = process.env.NETWORK === 'test' ? 'test' : 'main'
const dataDir = path.resolve(process.env.DONOR_DATA_DIR ?? process.env.CPP_DATA_DIR ?? 'data') // one directory per donor agent: key, wallet, memos, lock
fs.mkdirSync(dataDir, { recursive: true })
acquireLock(path.join(dataDir, 'donor.lock')) // one donor agent per state: two would pledge twice
const mandateFile = process.env.DONOR_MANDATE ?? path.join(dataDir, 'donor-mandate.json')
if (!fs.existsSync(mandateFile)) {
  console.error(`No terms found at ${mandateFile}. Copy donor-mandate.example.json there and edit it.`)
  process.exit(1)
}
const mandate = parseMandate(JSON.parse(fs.readFileSync(mandateFile, 'utf8')))
if (mandate.mode === 'copilot' && mandate.donorIdentityKey === undefined) {
  console.warn('[donor] warning: co-pilot without donorIdentityKey in the mandate. Approvals cannot check that YOUR wallet made the pledge, so the budget bookkeeping could count someone else\'s pledge. Add your BSV Desktop identity key.')
}
const serverUrl = process.env.CRYPTOPLEDGEPOT_URL ?? 'http://localhost:8787'
const chainTracker = new ArcadeChainTracker(network === 'main' ? ARCADE_MAINNET : ARCADE_TESTNET)
const txExists = async (txid: string): Promise<boolean> => (await fetch(`https://api.whatsonchain.com/v1/bsv/${network}/tx/hash/${txid}`)).ok

const health = await fetch(`${serverUrl}/api/health`).then(async r => await r.json(), () => {
  console.error(`Can't reach the CryptoPledgePot server at ${serverUrl}.\n` +
    '  - Server on this machine: start it with npm run server.\n' +
    '  - Docker stack: point at Caddy\'s local entrance: CRYPTOPLEDGEPOT_URL=http://127.0.0.1:8081 npm run donor\n' +
    '    (or use the donor agent already in Docker: --profile donor, at https://localhost:8444/#/donor).')
  process.exit(1)
})
if (health.network === 'mock' && mandate.mode === 'autopilot') {
  console.error('The server is the offline demo (network "mock"): an autopilot donor agent with a real wallet refuses to run against it.')
  process.exit(1)
}

let wallet: WalletInterface | undefined
let client: CryptoPledgePot | undefined
if (mandate.mode === 'autopilot') {
  const setup = await createToolboxWallet({
    chain: network,
    rootKey: loadOrCreateKey('DONOR_ROOT_KEY', path.join(dataDir, 'donor.key')),
    dbFile: path.join(dataDir, 'donor-wallet.sqlite'),
    dbName: 'cryptopledgepot_donor'
  })
  wallet = setup.wallet
  client = new CryptoPledgePot(wallet, new CryptoPledgePotApi(serverUrl, wallet))
}
const api = new CryptoPledgePotApi(serverUrl, wallet)
const memos = new MemoBook(fileStore<Memo[]>(path.join(dataDir, 'donor-memos.json'), []))
// Report anchors are not kept by the CryptoPledgePot server: fetch them (with proof) from WhatsOnChain.
const fetchTx = async (txid: string): Promise<Transaction> => {
  const bytes = Utils.toArray(await wocBeef(txid, network), 'hex')
  try { return Transaction.fromAtomicBEEF(bytes) } catch { return Transaction.fromBEEF(bytes, txid) }
}
const agent = new DonorAgent(mandate, { api, client, brain: defaultDonorBrain(), memos, chainTracker, txExists, fetchTx, spendable: wallet !== undefined ? async () => await spendable() : undefined })

const spendable = async (): Promise<number> => {
  if (wallet === undefined) return 0
  const { outputs } = await wallet.listOutputs({ basket: 'default', limit: 1000 })
  return outputs.filter(o => o.spendable).reduce((sum, o) => sum + o.satoshis, 0)
}
let last: StepSummary | undefined
let running = false
const runStep = async (): Promise<StepSummary> => {
  if (running) return last ?? { evaluated: 0, proposed: 0, pledged: 0, skipped: 0, votes: 0, refunds: 0 }
  running = true
  try { last = await agent.step(); return last } finally { running = false }
}

const port = Number(process.env.DONOR_PORT ?? 8792)
// 127.0.0.1 by default: a personal agent. In Docker it listens inside its container (DONOR_HOST=0.0.0.0), and only
// Caddy's local-only entrance (127.0.0.1:8444) forwards to it; the public link never does.
const host = process.env.DONOR_HOST ?? '127.0.0.1'
createDonorApp({ agent, wallet, chainTracker, spendable, lastStep: () => last, runStep }).listen(port, host, () => {
  console.log(`[donor] "${mandate.name}" · ${mandate.mode} · budget ${mandate.budget.totalSats} sats · brain ${agent.deps.brain.name} · http://127.0.0.1:${port}/api/donor`)
})
const intervalMs = Number(process.env.DONOR_INTERVAL_S ?? 60) * 1000
for (;;) {
  try { const s = await runStep(); console.log(`[donor] round: ${JSON.stringify(s)}`) } catch (e) { console.error(`[donor] round failed: ${(e as Error).message}`) }
  await new Promise(resolve => setTimeout(resolve, intervalMs))
}
