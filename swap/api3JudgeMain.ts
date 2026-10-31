/**
 * npm run api3:judge: check the deployed PriceGuardedHTLC yourself, with your
 * own signed BSV/USD response from API3 AirnodeHub.
 *
 *   API3_PAYER_KEY=0x… npm run api3:judge          fetch a live response (0.001 aUSD on Base Sepolia, x402)
 *   npm run api3:judge -- my-response.json          a response you fetched yourself (or - for stdin)
 *   npm run api3:judge -- --local                   offline: Anvil, the contract deployed with a test Airnode key
 *
 * It prints the deployment (deployments/api3-price-guard.json) and checks it
 * against the chain, then submits the response as signed plus four tampered
 * versions as free eth_calls: one is accepted, four are refused. API3_RPC_URL
 * overrides the record's public RPC.
 */
import fs from 'node:fs'
import { createPublicClient, http, type Address, type Hex, type PublicClient } from 'viem'
import { anvil as anvilChain } from 'viem/chains'
import { anvilAccount, startAnvil } from './anvil'
import { BSV_USD_REQUEST, bsvUsdData, createPayingFetch, deriveRequestHash, fetchBsvUsd, readPrice, recoverSigner, signAsAirnode, type SignedResponse } from './api3Price'
import { checkDeployment, DEPLOYMENT_FILE, formatTamperTest, readDeployment, runTamperTest } from './api3Proof'
import { DEFAULT_PRICE_GUARD, deployBridgeContracts } from './evmChain'

const args = process.argv.slice(2)
let client: PublicClient
let htlc: Address
let token: Address
let response: SignedResponse
let stop = async (): Promise<void> => {}

if (args.includes('--local')) {
  // Offline: a local chain whose guard trusts a test key, so a "fresh signed response" can be made on the spot.
  const node = await startAnvil()
  stop = node.stop
  const testAirnode = anvilAccount(9)
  const d = await deployBridgeContracts(node.rpcUrl, anvilChain, anvilAccount(0), { withTestToken: true, priceGuard: { airnode: testAirnode.address, requestHash: deriveRequestHash(BSV_USD_REQUEST), ...DEFAULT_PRICE_GUARD } })
  client = createPublicClient({ chain: anvilChain, transport: http(node.rpcUrl) })
  htlc = d.htlc
  token = d.token!
  const t = Number((await client.getBlock()).timestamp)
  response = await signAsAirnode(testAirnode, deriveRequestHash(BSV_USD_REQUEST), t - 5, bsvUsdData(17.45, t - 60))
  console.log(`LOCAL chain (Anvil): PriceGuardedHTLC ${htlc}, Airnode = test key ${testAirnode.address}\n`)
} else {
  const d = readDeployment()
  if (d === undefined) {
    console.error(`${DEPLOYMENT_FILE} not found: the contract has not been deployed from this checkout yet (npm run evm:deploy with BRIDGE_PRICE_GUARD=api3). Use --local for the offline version.`)
    process.exit(1)
  }
  client = createPublicClient({ transport: http(process.env.API3_RPC_URL ?? d.rpcUrl) })
  htlc = d.address
  token = d.token
  console.log(`Deployed PriceGuardedHTLC on ${d.network} (chain ${d.chainId})`)
  console.log(`  address   ${d.address}${d.explorer !== undefined ? `  ${d.explorer}` : ''}`)
  console.log(`  deploy tx ${d.deployTx} (block ${d.blockNumber}, ${d.deployedAt})`)
  console.log(`  airnode   ${d.airnode} · request ${d.requestHash} · ±${d.maxDeviationBps / 100}% · response ≤ ${d.maxResponseAge}s · price ≤ ${d.maxPriceAge}s`)
  const problems = await checkDeployment(client, d, { expectCoinPaprika: true })
  console.log(problems.length === 0 ? '  ✓ read back from the chain: the contract has exactly these settings\n' : problems.map(p => `  ✗ ${p}`).join('\n') + '\n')
  if (problems.length > 0) process.exit(1)

  const file = args.find(a => !a.startsWith('--'))
  if (file !== undefined) {
    const raw = JSON.parse(file === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(file, 'utf8')) as SignedResponse | { response: SignedResponse }
    response = 'response' in raw ? raw.response : raw
    console.log(`Your response (${file === '-' ? 'stdin' : file}):`)
  } else if ((process.env.API3_PAYER_KEY ?? '') !== '') {
    response = await fetchBsvUsd(await createPayingFetch(process.env.API3_PAYER_KEY as Hex))
    console.log('Live response from CoinPaprika\'s Airnode on AirnodeHub (paid 0.001 aUSD):')
  } else {
    console.error('Pass a signed response file (or - for stdin), or set API3_PAYER_KEY to fetch one live.')
    process.exit(1)
  }
}

const { usd, updatedAt } = readPrice(response)
console.log(`  data      ${response.data}`)
console.log(`  signed by ${await recoverSigner(response)} at ${new Date(Number(response.timestamp) * 1000).toISOString()} (price taken ${new Date(updatedAt * 1000).toISOString()}, $${usd})\n`)

const cases = await runTamperTest(client, htlc, token, response)
console.log(formatTamperTest(cases))
await stop()
process.exit(cases.every(c => c.pass) ? 0 : 1)
