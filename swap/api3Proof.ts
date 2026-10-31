/**
 * Proof for the API3 track that anyone can re-run against the deployed
 * PriceGuardedHTLC, with their own signed response.
 *
 *  - The deployment record (deployments/api3-price-guard.json): network,
 *    address, deploy transaction and the settings the contract was built with.
 *    checkDeployment reads the contract's immutables back from the chain, so the
 *    record cannot claim settings the contract does not have.
 *  - runTamperTest: one signed BSV/USD response, five submissions, all as
 *    eth_calls (free, no funds needed). The response as signed is accepted; four
 *    manipulated versions are refused by the contract with the expected error:
 *      1. the response as signed                      → accepted
 *      2. price edited after signing                  → NotSignedByAirnode
 *      3. timestamp moved after signing               → NotSignedByAirnode
 *      4. a real API3 signature from another Airnode  → NotSignedByAirnode
 *      5. a fair response, but an unfair quote (−5%)  → RateOutsideTolerance
 */
import fs from 'node:fs'
import path from 'node:path'
import { BaseError, ContractFunctionRevertedError, getAddress, toHex, type Address, type Hex, type PublicClient } from 'viem'
import { BSV_USD_REQUEST, COINPAPRIKA_AIRNODE_ADDRESS, deriveRequestHash, type AirnodeV2Request, type SignedResponse } from './api3Price'
import { GUARDED_HTLC_ABI } from './evmChain'

/** What `npm run evm:deploy` with BRIDGE_PRICE_GUARD=api3 writes, and what `npm run api3:judge` reads. */
export interface Api3Deployment {
  contract: 'PriceGuardedHTLC'
  network: string
  chainId: number
  /** A public RPC judges can use (not the deployer's, which may carry an API key). */
  rpcUrl: string
  address: Address
  deployTx: Hex
  blockNumber: number
  deployer: Address
  deployedAt: string
  /** Contract page on a block explorer. */
  explorer?: string
  /** The stablecoin lockWithPrice is meant for (Circle's test USDC on Base Sepolia). */
  token: Address
  airnode: Address
  requestHash: Hex
  request: AirnodeV2Request
  maxDeviationBps: number
  maxResponseAge: number
  maxPriceAge: number
}

export const DEPLOYMENT_FILE = path.join('deployments', 'api3-price-guard.json')

/** Public endpoints, so the record never stores a deployer's private RPC URL. */
export const PUBLIC_NETWORKS: Record<number, { rpcUrl: string, explorer: string, usdc: Address }> = {
  84532: { rpcUrl: 'https://sepolia.base.org', explorer: 'https://sepolia.basescan.org/address/', usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e' }
}

export function readDeployment (file = DEPLOYMENT_FILE): Api3Deployment | undefined {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) as Api3Deployment : undefined
}

export function writeDeployment (d: Api3Deployment, file = DEPLOYMENT_FILE): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(d, null, 2) + '\n')
}

/** Compare the record with the contract on chain. Returns the problems found (empty: the record is true). */
export async function checkDeployment (client: PublicClient, d: Api3Deployment, opts: { expectCoinPaprika?: boolean } = {}): Promise<string[]> {
  const problems: string[] = []
  if (await client.getChainId() !== d.chainId) problems.push(`the RPC is on chain ${await client.getChainId()}, the record says ${d.chainId}`)
  const code = await client.getCode({ address: d.address })
  if (code === undefined || code === '0x') return [...problems, `no contract at ${d.address}`]
  const read = async (functionName: string): Promise<unknown> => await client.readContract({ address: d.address, abi: GUARDED_HTLC_ABI, functionName })
  let airnode: Address, requestHash: Hex, bps: number
  try {
    airnode = getAddress(await read('airnode') as string)
    requestHash = await read('requestHash') as Hex
    bps = Number(await read('maxDeviationBps') as bigint)
  } catch (e) { return [...problems, `${d.address} is not a PriceGuardedHTLC (${revertName(e)})`] }
  if (airnode !== getAddress(d.airnode)) problems.push(`airnode on chain is ${airnode}, the record says ${d.airnode}`)
  if (requestHash !== d.requestHash) problems.push(`requestHash on chain is ${requestHash}, the record says ${d.requestHash}`)
  if (requestHash !== deriveRequestHash(d.request)) problems.push('the recorded request does not hash to the contract\'s requestHash')
  if (bps !== d.maxDeviationBps) problems.push(`maxDeviationBps on chain is ${bps}, the record says ${d.maxDeviationBps}`)
  if (opts.expectCoinPaprika === true) {
    if (airnode !== getAddress(COINPAPRIKA_AIRNODE_ADDRESS)) problems.push(`airnode ${airnode} is not CoinPaprika's on AirnodeHub (${COINPAPRIKA_AIRNODE_ADDRESS})`)
    if (requestHash !== deriveRequestHash(BSV_USD_REQUEST)) problems.push('requestHash is not BSV/USD (BSV_USD_REQUEST)')
  }
  return problems
}

/**
 * A REAL response from another API3 Airnode (Nodary, USDC/USD, fetched
 * 2026-10-31; also test/fixtures/api3-nodary-usdc-usd.json). Its signature is
 * genuine, but not by the guard's Airnode and not for its request.
 */
export const FOREIGN_API3_RESPONSE: SignedResponse = {
  airnode: '0xE70f1e8b22a21e4Bb5188918a3033341b281E4c0',
  requestHash: '0x1e48b74ff3f1ecc03021f5995066862e7e2d623c4e5f6e23e1f6fb2061205378',
  timestamp: '1793411232',
  data: '{"price":1.001,"updatedAt":1793411221497}',
  signature: '0xf5cd7fc020af7f396abb3fb6aec599f4049b43cd7b1268dbbdb950702940900229588ffda5cf0ef7656ea0b025d200391b36c21a1400941c9d53b7fcc6b4bd3f1b'
}

export interface TamperCase {
  name: string
  /** What the contract must answer: 'accepted' or the custom error's name. */
  expected: string
  /** What it did answer. */
  got: string
  pass: boolean
  detail: string
}

/** The custom error a reverted call carries (e.g. NotSignedByAirnode), or the message if it is not a revert. */
export function revertName (e: unknown): string {
  if (e instanceof BaseError) {
    const r = e.walk(x => x instanceof ContractFunctionRevertedError)
    if (r instanceof ContractFunctionRevertedError) return r.data?.errorName ?? r.reason ?? 'reverted'
    return e.shortMessage
  }
  return String(e)
}

/** Replace the "price" number in projected data, keeping every other byte. */
export const withPrice = (data: string, price: number): string => data.replace(/("price":)[0-9.eE+-]+/, `$1${price}`)

export interface TamperTestOptions {
  /** Stablecoin amount for the quote, micro-USDC (default 100 USDC). */
  amount?: bigint
  /** The honest agent's spread below the fair rate, basis points (default 50 = 0.5%). */
  spreadBps?: bigint
  /** Who the eth_calls come from (no funds needed). */
  from?: Address
}

/**
 * Submit one signed response and four manipulations of it to the guard, as
 * eth_calls of lockWithPrice (the price checks run before any token moves, so
 * a refusal needs no allowance or balance). The accepted case is checked with
 * the same view functions lockWithPrice uses: checkedPrice, fairSats,
 * withinTolerance.
 */
export async function runTamperTest (client: PublicClient, htlc: Address, token: Address, r: SignedResponse, opts: TamperTestOptions = {}): Promise<TamperCase[]> {
  const amount = opts.amount ?? 100_000_000n
  const from = opts.from ?? '0x000000000000000000000000000000000000dEaD'
  const now = (await client.getBlock({ blockTag: 'latest' })).timestamp
  const view = async <T>(functionName: string, args: unknown[]): Promise<T> => await client.readContract({ address: htlc, abi: GUARDED_HTLC_ABI, functionName, args }) as T
  const lockCall = async (quotedSats: bigint, p: SignedResponse): Promise<string> => {
    try {
      await client.simulateContract({
        account: from,
        address: htlc,
        abi: GUARDED_HTLC_ABI,
        functionName: 'lockWithPrice',
        args: [from, token, amount, toHex(1n, { size: 32 }), now + 4n * 3600n, quotedSats, BigInt(p.timestamp), toHex(p.data), p.signature]
      })
      return 'accepted'
    } catch (e) { return revertName(e) }
  }
  const cases: TamperCase[] = []
  const add = (name: string, expected: string, got: string, detail: string): void => { cases.push({ name, expected, got, pass: got === expected, detail }) }

  // 1. As signed: the contract verifies it and an honest quote (fair − spread) is within tolerance.
  let fair = 0n
  let honest = 0n
  try {
    const [price] = await view<[bigint, bigint]>('checkedPrice', [BigInt(r.timestamp), toHex(r.data), r.signature])
    fair = await view<bigint>('fairSats', [amount, price])
    honest = fair - (fair * (opts.spreadBps ?? 50n)) / 10_000n
    const ok = await view<boolean>('withinTolerance', [honest, fair])
    add('Signed response, as received', 'accepted', ok ? 'accepted' : 'RateOutsideTolerance',
      `BSV = $${(Number(price) / 1e18).toFixed(4)}; ${Number(amount) / 1e6} USDC = ${fair} sats fair, quote ${honest}`)
  } catch (e) {
    const why = revertName(e)
    add('Signed response, as received', 'accepted', why, why === 'NotSignedByAirnode'
      ? 'not signed by this contract\'s Airnode for its request (BSV/USD from CoinPaprika)'
      : /TooOld|Future/.test(why) ? 'outside the freshness window: fetch a fresh response' : 'the contract refused the response itself')
  }
  // Without a fair rate from case 1 the rest still runs, against a nominal quote.
  if (honest === 0n) honest = 1_000_000n

  // 2. Price halved after signing: a quote of half the sats would then look fair.
  const fakePrice = Number(JSON.parse(r.data).price) / 2
  add('Price edited after signing', 'NotSignedByAirnode', await lockCall(honest / 2n, { ...r, data: withPrice(r.data, fakePrice) }),
    `"price" changed to ${fakePrice}, the quote halved to match`)

  // 3. Timestamp pushed forward: what someone would do to pass a stale response off as fresh.
  add('Timestamp moved after signing', 'NotSignedByAirnode', await lockCall(honest, { ...r, timestamp: String(BigInt(r.timestamp) + 600n) }),
    'timestamp + 10 min (the signature covers it)')

  // 4. A genuine API3 signature, but from another Airnode for another request.
  add('Real API3 signature, other Airnode', 'NotSignedByAirnode', await lockCall(honest, FOREIGN_API3_RESPONSE),
    `Nodary USDC/USD, signed by ${FOREIGN_API3_RESPONSE.airnode}`)

  // 5. The response is fine; the quote is 5% below the market.
  const greedy = fair > 0n ? fair - (fair * 500n) / 10_000n : honest
  add('Valid response, quote 5% below market', 'RateOutsideTolerance', await lockCall(greedy, r),
    `quote ${greedy} sats vs fair ${fair}`)

  return cases
}

/** The cases as a table for a terminal (and the video). */
export function formatTamperTest (cases: TamperCase[]): string {
  const rows = cases.map((c, i) => {
    const mark = c.pass ? (c.expected === 'accepted' ? '✅' : '🛑') : '❌'
    return `${mark} ${i + 1}. ${c.name.padEnd(38)} ${c.got.padEnd(22)} ${c.detail}${c.pass ? '' : `   (expected ${c.expected})`}`
  })
  const accepted = cases.filter(c => c.got === 'accepted').length
  const allPass = cases.every(c => c.pass)
  return [...rows, '', allPass
    ? `${accepted} accepted, ${cases.length - accepted} rejected: exactly as expected.`
    : `NOT as expected: ${cases.filter(c => !c.pass).length} case(s) differ.`].join('\n')
}
