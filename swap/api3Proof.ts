/**
 * Proof for the API3 track that anyone can re-run against the deployed
 * PriceGuardedHTLC, with their own signed responses.
 *
 *  - The deployment record (deployments/api3-price-guard.json): network,
 *    address, deploy transaction and the settings the contract was built with.
 *    checkDeployment reads the contract's immutables back from the chain, so the
 *    record cannot claim settings the contract does not have.
 *  - runTamperTest: the API3 track's tamper test, exactly as the rules define
 *    it. First a valid, timely response triggers the on-chain action (a real
 *    lockWithPrice transaction that locks USDC for a swap); then four responses
 *    are rejected before that action:
 *      1. valid, timely response                        → locked (transaction)
 *      2. a real response with one value edited         → NotSignedByAirnode
 *      3. a real response that is too old               → ResponseTooOld
 *      4. a real response to a different request        → NotSignedByAirnode
 *      5. a response signed by a key that is not the
 *         expected Airnode's                            → NotSignedByAirnode
 *    (3 and 4 recover a different signer because the contract puts its STORED
 *    request hash into the signature check, never the caller's.)
 */
import fs from 'node:fs'
import path from 'node:path'
import { BaseError, ContractFunctionRevertedError, createWalletClient, getAddress, http, parseEventLogs, toHex, type Account, type Address, type Chain, type Hex, type PublicClient } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { BSV_USD_REQUEST, COINPAPRIKA_AIRNODE_ADDRESS, deriveRequestHash, signAsAirnode, type AirnodeV2Request, type SignedResponse } from './api3Price'
import { GUARDED_HTLC_ABI, TOKEN_ABI } from './evmChain'

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
  /** True when `token` is the project's TestUSDC (6 decimals, anyone can mint), deployed with the guard. */
  testToken?: boolean
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

export interface TamperCase {
  name: string
  /** What the contract must answer: 'locked' for the valid response, else the custom error's name. */
  expected: string
  /** What it did answer. */
  got: string
  pass: boolean
  detail: string
  /** The transaction, when the case was sent on chain. */
  tx?: Hex
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

/**
 * The same request for another coin (BTC), from the same Airnode with the same
 * projection: what a "real response to a different request" answers.
 */
export const BTC_USD_REQUEST: AirnodeV2Request = { ...BSV_USD_REQUEST, parameters: { coin_id: 'btc-bitcoin', quotes: 'USD' } }

/** The five responses of the tamper test (the edited one is derived from `valid`). */
export interface TamperInputs {
  /** A valid, timely BSV/USD response from the contract's Airnode. */
  valid: SignedResponse
  /** A real response from the contract's Airnode to the same request, older than maxResponseAge. */
  stale?: SignedResponse
  /** A real response from the contract's Airnode to a different request (e.g. BTC_USD_REQUEST). */
  otherRequest?: SignedResponse
  /** Signed by a key that is not the Airnode's (e.g. one the judge signed). Default: valid's exact payload, re-signed by a fresh random key. */
  wrongSigner?: SignedResponse
  /** A real response with one value edited (e.g. by the judge). Default: valid with its price halved. */
  edited?: SignedResponse
}

export interface TamperTestOptions {
  /** Sends the valid lock as a real transaction (needs the token and gas). Without it, case 1 is a read-only check. */
  locker?: Account
  /** The chain, for sending transactions. */
  chain?: Chain
  rpcUrl?: string
  /** Also send the four rejected submissions as transactions, so their reverts are on the explorer (costs gas). */
  sendRejections?: boolean
  /** Stablecoin amount, micro-USDC (default 1 USDC). */
  amount?: bigint
  /** The honest agent's spread below the fair rate, basis points (default 50 = 0.5%). */
  spreadBps?: bigint
}

const randomHashlock = (): Hex => toHex(crypto.getRandomValues(new Uint8Array(32)))

/**
 * The tamper test. Case 1 locks for real (with `locker`); cases 2–5 are
 * submitted to lockWithPrice with the same quote and are refused before any
 * token moves, as eth_calls (free) or, with sendRejections, as transactions.
 */
export async function runTamperTest (client: PublicClient, htlc: Address, token: Address, inputs: TamperInputs, opts: TamperTestOptions = {}): Promise<TamperCase[]> {
  const amount = opts.amount ?? 1_000_000n
  const from: Address = opts.locker?.address ?? '0x000000000000000000000000000000000000dEaD'
  const now = (await client.getBlock({ blockTag: 'latest' })).timestamp
  const refundAfter = now + 3600n
  const view = async <T>(functionName: string, args: unknown[]): Promise<T> => await client.readContract({ address: htlc, abi: GUARDED_HTLC_ABI, functionName, args }) as T
  const wallet = opts.locker !== undefined && opts.rpcUrl !== undefined ? createWalletClient({ account: opts.locker, chain: opts.chain, transport: http(opts.rpcUrl) }) : undefined
  const lockArgs = (quotedSats: bigint, p: SignedResponse): unknown[] => [from, token, amount, randomHashlock(), refundAfter, quotedSats, BigInt(p.timestamp), toHex(p.data), p.signature]

  /** Submit a manipulated response: an eth_call, or a transaction with fixed gas (so it is mined and reverts on chain). */
  const reject = async (quotedSats: bigint, p: SignedResponse): Promise<{ got: string, tx?: Hex }> => {
    let got = 'locked'
    try { await client.simulateContract({ account: from, address: htlc, abi: GUARDED_HTLC_ABI, functionName: 'lockWithPrice', args: lockArgs(quotedSats, p) }) } catch (e) { got = revertName(e) }
    if (opts.sendRejections !== true || wallet === undefined) return { got }
    const tx = await wallet.writeContract({ address: htlc, abi: GUARDED_HTLC_ABI, functionName: 'lockWithPrice', args: lockArgs(quotedSats, p), gas: 500_000n, chain: opts.chain, account: opts.locker! })
    const receipt = await client.waitForTransactionReceipt({ hash: tx })
    return { got: receipt.status === 'reverted' ? got : 'locked', tx }
  }

  const cases: TamperCase[] = []
  const add = (c: Omit<TamperCase, 'pass'>): void => { cases.push({ ...c, pass: c.got === c.expected }) }

  // 1. Valid and timely: it drives the action. The quote comes from the signed price (fair − spread).
  let honest = 1_000_000n
  let fair = 0n
  try {
    const [price] = await view<[bigint, bigint]>('checkedPrice', [BigInt(inputs.valid.timestamp), toHex(inputs.valid.data), inputs.valid.signature])
    fair = await view<bigint>('fairSats', [amount, price])
    honest = fair - (fair * (opts.spreadBps ?? 50n)) / 10_000n
    const priced = `BSV = $${(Number(price) / 1e18).toFixed(4)}; ${Number(amount) / 1e6} USDC = ${fair} sats fair, quote ${honest}`
    if (wallet === undefined) {
      add({ name: 'Valid, timely response', expected: 'locked', got: 'locked', detail: `${priced} (read-only check: pass a locker key to send the lock)` })
    } else {
      await client.waitForTransactionReceipt({ hash: await wallet.writeContract({ address: token, abi: TOKEN_ABI, functionName: 'approve', args: [htlc, amount * 10n], chain: opts.chain, account: opts.locker! }) })
      const tx = await wallet.writeContract({ address: htlc, abi: GUARDED_HTLC_ABI, functionName: 'lockWithPrice', args: lockArgs(honest, inputs.valid), chain: opts.chain, account: opts.locker! })
      const receipt = await client.waitForTransactionReceipt({ hash: tx })
      const [checked] = parseEventLogs({ abi: GUARDED_HTLC_ABI, eventName: 'PriceChecked', logs: receipt.logs }) as unknown as Array<{ args: { id: Hex } }>
      add({ name: 'Valid, timely response', expected: 'locked', got: receipt.status === 'success' && checked !== undefined ? 'locked' : 'reverted', detail: `${priced}; lock ${checked?.args.id.slice(0, 18) ?? '?'}…`, tx })
    }
  } catch (e) {
    const why = revertName(e)
    add({ name: 'Valid, timely response', expected: 'locked', got: why, detail: /TooOld|Future/.test(why) ? 'outside the freshness window: fetch a fresh response' : why === 'NotSignedByAirnode' ? 'not signed by this contract\'s Airnode for its request' : 'the contract refused it' })
  }

  // 2. One value edited: by default the price halved, the quote halved to match, so the swap would look fair.
  if (inputs.edited !== undefined) {
    add({ name: 'Real response, one value edited', expected: 'NotSignedByAirnode', ...await reject(honest, inputs.edited), detail: `your edited response: ${inputs.edited.data.slice(0, 60)}` })
  } else {
    const fakePrice = Number(JSON.parse(inputs.valid.data).price) / 2
    add({ name: 'Real response, one value edited', expected: 'NotSignedByAirnode', ...await reject(honest / 2n, { ...inputs.valid, data: withPrice(inputs.valid.data, fakePrice) }), detail: `"price" changed to ${fakePrice} after signing` })
  }

  // 3. Too old: genuinely signed, by the right Airnode, for the right request, but outside maxResponseAge.
  if (inputs.stale !== undefined) {
    const age = Number(now) - Number(inputs.stale.timestamp)
    add({ name: 'Real response, too old', expected: 'ResponseTooOld', ...await reject(honest, inputs.stale), detail: `signed ${Math.round(age / 60)} min before this block` })
  } else add({ name: 'Real response, too old', expected: 'ResponseTooOld', got: 'missing', detail: 'no response older than the limit given (--stale)' })

  // 4. A different request: genuinely signed by the right Airnode, but it answers e.g. BTC/USD.
  if (inputs.otherRequest !== undefined) {
    add({ name: 'Real response, different request', expected: 'NotSignedByAirnode', ...await reject(honest, inputs.otherRequest), detail: `answers request ${inputs.otherRequest.requestHash.slice(0, 12)}…, the contract only ${(await view<Hex>('requestHash', [])).slice(0, 12)}…` })
  } else add({ name: 'Real response, different request', expected: 'NotSignedByAirnode', got: 'missing', detail: 'no response to another request given (--other)' })

  // 5. Not the Airnode's key: the same request, timestamp and data, signed by someone else.
  const wrong = inputs.wrongSigner ?? await signAsAirnode(privateKeyToAccount(generatePrivateKey()), inputs.valid.requestHash, Number(inputs.valid.timestamp), inputs.valid.data)
  add({ name: 'Signed by a key that is not the Airnode\'s', expected: 'NotSignedByAirnode', ...await reject(honest, wrong), detail: `signer ${wrong.airnode}` })

  return cases
}

/** The cases as a table for a terminal (and the video). */
export function formatTamperTest (cases: TamperCase[], explorerTx?: string): string {
  const rows = cases.map((c, i) => {
    const mark = c.pass ? (c.expected === 'locked' ? '✅' : '🛑') : '❌'
    const tx = c.tx !== undefined ? `\n      tx ${explorerTx !== undefined ? explorerTx + c.tx : c.tx}` : ''
    return `${mark} ${i + 1}. ${c.name.padEnd(42)} ${c.got.padEnd(20)} ${c.detail}${c.pass ? '' : `   (expected ${c.expected})`}${tx}`
  })
  const allPass = cases.every(c => c.pass)
  return [...rows, '', allPass
    ? 'PASS: 1 valid response locked, 4 tampered responses rejected before the lock.'
    : `FAIL: ${cases.filter(c => !c.pass).length} case(s) differ from the expected result.`].join('\n')
}
