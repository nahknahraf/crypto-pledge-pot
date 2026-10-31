/**
 * npm run api3:judge: the API3 tamper test against the deployed
 * PriceGuardedHTLC, with your own signed responses.
 *
 *   API3_PAYER_KEY=0x… npm run api3:judge                 fetch live responses (BSV/USD and BTC/USD, 0.001 aUSD each)
 *   npm run api3:judge -- fresh.json [--stale old.json] [--other btc.json] [--edited e.json] [--wrong w.json]
 *                                                         responses you fetched (or edited, or signed) yourself;
 *                                                         - reads fresh from stdin
 *   API3_LOCKER_KEY=0x… …                                 also send the valid lock as a real transaction
 *                                                         (Base Sepolia key holding test USDC and a little ETH)
 *   … --send-rejections                                   send the four rejected ones as transactions too
 *   npm run api3:judge -- --local                         offline: Anvil, the contract deployed with a test Airnode key
 *
 * The test, as the API3 track defines it: a valid, timely response triggers
 * the lock; then a real response with one value edited, a real response that
 * is too old, a real response to a different request, and a response signed
 * by a key that is not the Airnode's are each rejected before the lock.
 *
 * Responses must come from the POST / route (the request that `npm run
 * api3:price` prints): the AirnodeHub website and its MCP server use the
 * passthrough route, which hashes the same request differently, so the
 * contract refuses those as "a different request".
 *
 * Without API3_PAYER_KEY / API3_LOCKER_KEY, the team key in data/api3-team.key
 * is used if it exists (the team's own runs; judges pass their own keys).
 *
 * Every live response is saved in deployments/api3-responses/, so a later run
 * (or a judge) has a genuinely old response and a response to another request
 * without paying again. API3_RPC_URL overrides the record's public RPC.
 */
import fs from 'node:fs'
import path from 'node:path'
import { createPublicClient, getAddress, http, type Account, type Address, type Chain, type Hex, type PublicClient } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { anvil as anvilChain, baseSepolia } from 'viem/chains'
import { anvilAccount, startAnvil } from './anvil'
import { BSV_USD_REQUEST, bsvUsdData, COINPAPRIKA_AIRNODE_URL, createPayingFetch, deriveRequestHash, fetchBsvUsd, fetchSignedResponse, readPrice, recoverSigner, signAsAirnode, verifySignedResponse, type SignedResponse } from './api3Price'
import { BTC_USD_REQUEST, checkDeployment, DEPLOYMENT_FILE, formatTamperTest, PUBLIC_NETWORKS, readDeployment, runTamperTest, type TamperInputs } from './api3Proof'
import { DEFAULT_PRICE_GUARD, deployBridgeContracts, mintTestUsdc } from './evmChain'

const RESPONSES_DIR = path.join('deployments', 'api3-responses')
const args = process.argv.slice(2)
const flag = (name: string): string | undefined => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }
const FILE_FLAGS = ['--stale', '--other', '--edited', '--wrong']
const TEAM_KEY = path.join('data', 'api3-team.key')
const envKey = (name: string): string => process.env[name] ?? (fs.existsSync(TEAM_KEY) ? fs.readFileSync(TEAM_KEY, 'utf8').trim() : '')
const readResponse = (file: string): SignedResponse => {
  const raw = JSON.parse(file === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(file, 'utf8')) as SignedResponse | { response: SignedResponse }
  return 'response' in raw ? raw.response : raw
}
const saved = (requestHash: Hex): Array<{ file: string, r: SignedResponse }> => !fs.existsSync(RESPONSES_DIR)
  ? []
  : fs.readdirSync(RESPONSES_DIR).filter(f => f.endsWith('.json')).map(f => ({ file: path.join(RESPONSES_DIR, f), r: readResponse(path.join(RESPONSES_DIR, f)) }))
    .filter(x => x.r.requestHash === requestHash).sort((a, b) => Number(a.r.timestamp) - Number(b.r.timestamp))
const save = (name: string, r: SignedResponse): void => {
  fs.mkdirSync(RESPONSES_DIR, { recursive: true })
  fs.writeFileSync(path.join(RESPONSES_DIR, `${r.timestamp}-${name}.json`), JSON.stringify(r, null, 2) + '\n')
}

let client: PublicClient
let chain: Chain | undefined
let rpcUrl: string
let htlc: Address
let token: Address
let inputs: TamperInputs
let locker: Account | undefined
let explorerTx: string | undefined
let stop = async (): Promise<void> => {}

if (args.includes('--local')) {
  // Offline: a local chain whose guard trusts a test key, so every kind of response can be made on the spot.
  const node = await startAnvil()
  stop = node.stop
  const testAirnode = anvilAccount(9)
  const d = await deployBridgeContracts(node.rpcUrl, anvilChain, anvilAccount(0), { withTestToken: true, priceGuard: { airnode: testAirnode.address, requestHash: deriveRequestHash(BSV_USD_REQUEST), ...DEFAULT_PRICE_GUARD } })
  chain = anvilChain
  rpcUrl = node.rpcUrl
  client = createPublicClient({ chain, transport: http(rpcUrl) })
  htlc = d.htlc
  token = d.token!
  locker = anvilAccount(1)
  await mintTestUsdc(rpcUrl, anvilChain, anvilAccount(0), token, locker.address, 100_000_000)
  const t = Number((await client.getBlock()).timestamp)
  inputs = {
    valid: await signAsAirnode(testAirnode, deriveRequestHash(BSV_USD_REQUEST), t - 5, bsvUsdData(17.45, t - 60)),
    stale: await signAsAirnode(testAirnode, deriveRequestHash(BSV_USD_REQUEST), t - 3600, bsvUsdData(17.61, t - 3660)),
    otherRequest: await signAsAirnode(testAirnode, deriveRequestHash(BTC_USD_REQUEST), t - 5, bsvUsdData(68_250, t - 60))
  }
  console.log(`LOCAL chain (Anvil): PriceGuardedHTLC ${htlc}, Airnode = test key ${testAirnode.address}\n`)
} else {
  const d = readDeployment()
  if (d === undefined) {
    console.error(`${DEPLOYMENT_FILE} not found: the contract has not been deployed from this checkout yet (npm run evm:deploy with BRIDGE_PRICE_GUARD=api3). Use --local for the offline version.`)
    process.exit(1)
  }
  chain = d.chainId === baseSepolia.id ? baseSepolia : undefined
  rpcUrl = process.env.API3_RPC_URL ?? d.rpcUrl
  client = createPublicClient({ transport: http(rpcUrl) })
  htlc = d.address
  token = d.token
  const pub = PUBLIC_NETWORKS[d.chainId]
  explorerTx = pub !== undefined ? pub.explorer.replace('/address/', '/tx/') : undefined
  console.log(`Deployed PriceGuardedHTLC on ${d.network} (chain ${d.chainId})`)
  console.log(`  address   ${d.address}${d.explorer !== undefined ? `  ${d.explorer}` : ''}`)
  console.log(`  deploy tx ${d.deployTx} (block ${d.blockNumber}, ${d.deployedAt})`)
  console.log(`  airnode   ${d.airnode} · request ${d.requestHash} · ±${d.maxDeviationBps / 100}% · response ≤ ${d.maxResponseAge}s · price ≤ ${d.maxPriceAge}s`)
  const problems = await checkDeployment(client, d, { expectCoinPaprika: true })
  console.log(problems.length === 0 ? '  ✓ read back from the chain: the contract has exactly these settings\n' : problems.map(p => `  ✗ ${p}`).join('\n') + '\n')
  if (problems.length > 0) process.exit(1)

  const payer = envKey('API3_PAYER_KEY')
  const paying = payer !== '' ? await createPayingFetch(payer as Hex) : undefined
  const file = args.find((a, i) => !a.startsWith('--') && !FILE_FLAGS.includes(args[i - 1] ?? ''))
  let valid: SignedResponse
  if (file !== undefined) {
    valid = readResponse(file)
  } else if (paying !== undefined) {
    valid = await fetchBsvUsd(paying)
    save('bsv-usd', valid)
  } else {
    console.error('Pass a fresh signed BSV/USD response (file, or - for stdin), or set API3_PAYER_KEY to fetch one live.')
    process.exit(1)
  }
  let otherRequest = flag('--other') !== undefined ? readResponse(flag('--other')!) : saved(deriveRequestHash(BTC_USD_REQUEST)).at(-1)?.r
  if (otherRequest === undefined && paying !== undefined) {
    otherRequest = await fetchSignedResponse(COINPAPRIKA_AIRNODE_URL, BTC_USD_REQUEST, paying)
    await verifySignedResponse(otherRequest, d.airnode, deriveRequestHash(BTC_USD_REQUEST))
    save('btc-usd', otherRequest)
  }
  const now = Number((await client.getBlock()).timestamp)
  const stale = flag('--stale') !== undefined
    ? readResponse(flag('--stale')!)
    : saved(d.requestHash).filter(x => Number(x.r.timestamp) + d.maxResponseAge < now).at(-1)?.r
  if (stale === undefined) console.log(`No BSV/USD response older than ${d.maxResponseAge / 60} min yet: run again in ${d.maxResponseAge / 60} minutes (this one is saved), or pass --stale.\n`)
  inputs = { valid, stale, otherRequest, edited: flag('--edited') !== undefined ? readResponse(flag('--edited')!) : undefined, wrongSigner: flag('--wrong') !== undefined ? readResponse(flag('--wrong')!) : undefined }
  const key = envKey('API3_LOCKER_KEY')
  if (key !== '') locker = privateKeyToAccount(key as Hex)
}

const { usd, updatedAt } = readPrice(inputs.valid)
console.log(`Valid response: ${inputs.valid.data}`)
console.log(`  signed by ${getAddress(await recoverSigner(inputs.valid))} at ${new Date(Number(inputs.valid.timestamp) * 1000).toISOString()} (price taken ${new Date(updatedAt * 1000).toISOString()}, $${usd})`)
if (locker !== undefined) console.log(`  locks for real from ${locker.address}${args.includes('--send-rejections') ? '; the four rejections are sent as transactions too' : '; the four rejections are eth_calls'}`)
console.log('')

const cases = await runTamperTest(client, htlc, token, inputs, { locker, chain, rpcUrl, sendRejections: args.includes('--send-rejections') })
console.log(formatTamperTest(cases, explorerTx))
await stop()
process.exit(cases.every(c => c.pass) ? 0 : 1)
