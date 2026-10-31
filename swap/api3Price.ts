/**
 * BSV/USD from API3 AirnodeHub, as signed data that a contract can verify.
 *
 * AirnodeHub serves APIs through Airnode v2, which signs every response with
 * EIP-191 over keccak256(requestHash, timestamp, data). PriceGuardedHTLC
 * (evm/contracts) stores the Airnode's address and the request hash at
 * deployment and verifies each response on chain, so whoever submits it
 * (donor, liquidity agent, keeper) does not need to be trusted.
 *
 * Source: CoinPaprika's Airnode on AirnodeHub (the free first-party Nodary
 * feeds have no BSV/USD). A call costs 0.001 aUSD, paid with x402 on Base
 * Sepolia (a testnet), see createPayingFetch.
 *
 * deriveRequestHash and recoverSigner are ported from the API3 starter
 * (github.com/api3dao/airnodehub-hackathon-starter, src/airnode-v2.ts, MIT).
 */
import { createRequire } from 'node:module'
import path from 'node:path'
import { encodePacked, getAddress, keccak256, recoverMessageAddress, toHex, type Account, type Address, type Hex } from 'viem'

/** The body of a POST to an Airnode v2 (airnodehub-docs.api3.org/airnode/http-interface). */
export interface AirnodeV2Request {
  operation: string
  parameters: Record<string, unknown>
  /** Maps each field of the projected response to the JSON Pointer of its value in the full response. */
  responseProjection?: Record<string, string>
}

/** A signed response. `data` is the exact string the Airnode signed; a contract receives it as bytes. */
export interface SignedResponse {
  airnode: Address
  requestHash: Hex
  /** Unix seconds, as a decimal string. */
  timestamp: string
  data: string
  signature: Hex
}

/** CoinPaprika on AirnodeHub (third-party attestation: the Airnode signs what CoinPaprika's API returned). */
export const COINPAPRIKA_AIRNODE_URL = 'https://airnode-coinpaprika.fly.dev/'
export const COINPAPRIKA_AIRNODE_ADDRESS: Address = '0xB8b7816a39A0bF55eF2ae9A282A1502ce35ff732'

/**
 * The one request PriceGuardedHTLC accepts: BSV's ticker in USD, cut down to
 * two fields. The projection is part of the request hash, so the contract can
 * rely on {"price": <number>, "updatedAt": "<ISO 8601>"}.
 */
export const BSV_USD_REQUEST: AirnodeV2Request = {
  operation: 'getTickersById',
  parameters: { coin_id: 'bsv-bitcoin-sv', quotes: 'USD' },
  responseProjection: { price: '/quotes/USD/price', updatedAt: '/last_updated' }
}

// The order in which the Airnode and Solidity compare strings: UTF-8 byte order.
const compareUtf8 = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b))
const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value === null || typeof value !== 'object') return value
  return Object.entries(value).sort(([a], [b]) => compareUtf8(a, b)).map(([key, nested]) => [key, canonicalize(nested)])
}

/** The request hash, computed without calling the Airnode, so a contract can store it before any response exists. */
export function deriveRequestHash ({ operation, parameters, responseProjection }: AirnodeV2Request): Hex {
  const request = [operation, canonicalize(parameters)]
  const hashed = responseProjection !== undefined ? [...request, canonicalize(responseProjection)] : request
  return keccak256(toHex(JSON.stringify(hashed)))
}

/** The address that signed a response (the same recovery as AirnodeV2Attestation.recoverSigner). */
export async function recoverSigner ({ requestHash, timestamp, data, signature }: SignedResponse): Promise<Address> {
  return await recoverMessageAddress({
    message: { raw: keccak256(encodePacked(['bytes32', 'uint256', 'bytes'], [requestHash, BigInt(timestamp), toHex(data)])) },
    signature
  })
}

/**
 * The same signer and request checks the contract makes, off-chain, so a bad
 * response fails before it costs gas. Freshness is the contract's job (it uses
 * the chain's clock).
 */
export async function verifySignedResponse (r: SignedResponse, airnode: Address, requestHash: Hex): Promise<void> {
  if (r.requestHash.toLowerCase() !== requestHash.toLowerCase()) throw new Error(`response answers another request (${r.requestHash})`)
  const signer = await recoverSigner({ ...r, requestHash })
  if (getAddress(signer) !== getAddress(airnode)) throw new Error(`response not signed by the expected Airnode (signer ${signer})`)
}

/** The price (USD per BSV) and its time (unix seconds) in a projected response. */
export function readPrice (r: Pick<SignedResponse, 'data'>): { usd: number, updatedAt: number } {
  const d = JSON.parse(r.data) as { price?: unknown, updatedAt?: unknown }
  const usd = Number(d.price)
  // CoinPaprika writes an ISO 8601 string; Nodary writes Unix milliseconds.
  const updatedAt = typeof d.updatedAt === 'number' ? Math.floor(d.updatedAt / 1000) : Math.floor(Date.parse(String(d.updatedAt)) / 1000)
  if (!(usd > 0) || !Number.isFinite(updatedAt)) throw new Error(`unexpected price data: ${r.data}`)
  return { usd, updatedAt }
}

/** POST the request to an Airnode and return its signed response. Pass a paying fetch for priced operations. */
export async function fetchSignedResponse (airnodeUrl: string, request: AirnodeV2Request, fetchFunction: typeof fetch = fetch): Promise<SignedResponse> {
  const res = await fetchFunction(airnodeUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request) })
  if (!res.ok) throw new Error(`the Airnode answered ${res.status}: ${await res.text()}`)
  return await res.json() as SignedResponse
}

/** A fresh, verified BSV/USD response from CoinPaprika's Airnode (paid: pass createPayingFetch(...)). */
export async function fetchBsvUsd (fetchFunction: typeof fetch = fetch): Promise<SignedResponse> {
  const r = await fetchSignedResponse(COINPAPRIKA_AIRNODE_URL, BSV_USD_REQUEST, fetchFunction)
  await verifySignedResponse(r, COINPAPRIKA_AIRNODE_ADDRESS, deriveRequestHash(BSV_USD_REQUEST))
  return r
}

/**
 * Sign a response the way an Airnode v2 does. For LOCAL chains and tests
 * only: a contract deployed with this account as its `airnode` accepts it.
 * Never deploy a production guard with a key you control.
 */
export async function signAsAirnode (account: Account, requestHash: Hex, timestamp: number, data: string): Promise<SignedResponse> {
  if (account.signMessage === undefined) throw new Error('account cannot sign messages')
  const digest = keccak256(encodePacked(['bytes32', 'uint256', 'bytes'], [requestHash, BigInt(timestamp), toHex(data)]))
  return { airnode: account.address, requestHash, timestamp: String(timestamp), data, signature: await account.signMessage({ message: { raw: digest } }) }
}

/** The projected BSV/USD data in CoinPaprika's shape, for local tests and demos. */
export const bsvUsdData = (usd: number, updatedAt: number): string =>
  JSON.stringify({ price: usd, updatedAt: new Date(updatedAt * 1000).toISOString().replace('.000Z', 'Z') })

/**
 * A fetch that answers HTTP 402 by paying the Airnode in aUSD on Base Sepolia
 * (x402), as the API3 starter's createPayingFetch does. The payer needs aUSD
 * from the AirnodeHub faucet, no ETH. The x402 client lives in evm/'s own
 * dependencies (npm install --prefix evm).
 */
export async function createPayingFetch (payerPrivateKey: Hex, fetchFunction: typeof fetch = fetch): Promise<typeof fetch> {
  const req = createRequire(path.resolve('evm', 'package.json'))
  // Untyped here on purpose: the packages live in evm/node_modules, outside the root tsconfig's reach.
  const { ExactEvmScheme } = req('@x402/evm') as { ExactEvmScheme: new (account: unknown) => unknown }
  const { wrapFetchWithPaymentFromConfig } = req('@x402/fetch') as { wrapFetchWithPaymentFromConfig: (f: typeof fetch, config: unknown) => typeof fetch }
  const { privateKeyToAccount } = await import('viem/accounts')
  const BASE_SEPOLIA = 'eip155:84532'
  const AUSD = '0xbeA34973e5f67F18F656A2C6070C64326C791808'
  return wrapFetchWithPaymentFromConfig(fetchFunction, {
    schemes: [{ network: BASE_SEPOLIA, client: new ExactEvmScheme(privateKeyToAccount(payerPrivateKey)) }],
    // Pay at most 1 aUSD per call, and only in aUSD.
    spendControls: { maxAmountPerPayment: '$1', allowedAssets: [{ network: BASE_SEPOLIA, asset: AUSD, maxAmountPerPayment: '1000000' }] },
    policies: [(_v: unknown, requirements: Array<{ asset: string }>) => requirements.filter(r => r.asset.toLowerCase() === AUSD.toLowerCase())]
  })
}
