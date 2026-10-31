/**
 * The API3 price guard: PriceGuardedHTLC on a real EVM chain (Foundry's Anvil),
 * driven through viem.
 *
 *  1. The contract's checks one by one, with responses signed by a local test
 *     key that the test deploys as the contract's Airnode: a fair quote passes;
 *     a quote too low or too high, a stale response, a stale price, the wrong
 *     signer, a response to another request and tampered data are refused.
 *  2. A REAL response signed by API3's Nodary Airnode (recorded fixture) is
 *     verified by the same contract code, and our request-hash derivation
 *     matches the hash the Airnode reported.
 *  3. The whole USDC → BSV swap with the guard: the liquidity agent quotes from
 *     a signed price; an honest quote goes through, a greedy one is refused by
 *     the contract before the donor's USDC move.
 *
 * Skipped if the anvil binary is not installed (dev dependency @foundry-rs/anvil).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import type { Server } from 'node:http'
import { Transaction } from '@bsv/sdk'
import type { Wallet } from '@bsv/wallet-toolbox'
import { createPublicClient, http, type Address, type Hex } from 'viem'
import { anvil as anvilChain } from 'viem/chains'
import { newSecret } from '../core/swap'
import { createCryptoPledgePotApp } from '../server/app'
import { CryptoPledgePotDb } from '../server/db'
import { anvilAccount, anvilBinary, startAnvil, type Anvil } from '../swap/anvil'
import { BSV_USD_REQUEST, bsvUsdData, deriveRequestHash, readPrice, signAsAirnode, verifySignedResponse, type AirnodeV2Request, type SignedResponse } from '../swap/api3Price'
import type { SpendFinder } from '../swap/bsv'
import { DonorSwap } from '../swap/donorSwap'
import { DEFAULT_PRICE_GUARD, deployBridgeContracts, EvmUsdcChain, GUARDED_HTLC_ABI, mintTestUsdc } from '../swap/evmChain'
import { DEFAULT_LIQUIDITY, LiquidityAgent } from '../swap/liquidityAgent'
import { USDC } from '../swap/usdcChain'
import { createMockChain, memoryKnex, type MockChain } from './helpers/mockchain'

const deployer = anvilAccount(0)
const fay = anvilAccount(1)
const lpAccount = anvilAccount(2)
/** Stands in for the Airnode on the local chain: the contract under test is deployed with its address. */
const testAirnode = anvilAccount(9)
const impostor = anvilAccount(8)
const REQUEST_HASH = deriveRequestHash(BSV_USD_REQUEST)

const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/api3-nodary-usdc-usd.json', import.meta.url), 'utf8')) as { request: AirnodeV2Request, response: SignedResponse }

describe.skipIf(anvilBinary() === undefined)('API3 price guard on a real EVM chain (Anvil)', () => {
  let node: Anvil, evm: EvmUsdcChain, htlc: Address
  const now = async (): Promise<number> => await evm.now()
  /** A signed BSV/USD response, by default from the contract's Airnode, for the right request, fresh. */
  const response = async (usd: number, o: { age?: number, priceAge?: number, signer?: typeof testAirnode, requestHash?: Hex } = {}): Promise<SignedResponse> => {
    const t = await now()
    return await signAsAirnode(o.signer ?? testAirnode, o.requestHash ?? REQUEST_HASH, t - (o.age ?? 5), bsvUsdData(usd, t - (o.priceAge ?? 30)))
  }
  const lockWith = async (quotedSats: number, priceProof: SignedResponse, amount = 100 * USDC): Promise<string> =>
    await evm.account(fay.address).lock({ receiver: lpAccount.address, amount, hashlock: newSecret().hashlock, refundAfter: (await now()) + 4 * 3600, quotedSats, priceProof })

  beforeAll(async () => {
    node = await startAnvil()
    const d = await deployBridgeContracts(node.rpcUrl, anvilChain, deployer, { withTestToken: true, priceGuard: { airnode: testAirnode.address, requestHash: REQUEST_HASH, ...DEFAULT_PRICE_GUARD } })
    htlc = d.htlc
    evm = new EvmUsdcChain({ name: 'USDC (local EVM chain, price-guarded)', rpcUrl: node.rpcUrl, chain: anvilChain, htlc, token: d.token!, signers: [fay, lpAccount], priceGuarded: true })
    await mintTestUsdc(node.rpcUrl, anvilChain, deployer, d.token!, fay.address, 10_000 * USDC)
  }, 120_000)
  afterAll(async () => { await node?.stop() })

  // BSV at $20: 100 USDC are worth exactly 5 BSV = 500,000,000 sats.
  const FAIR = 500_000_000

  it('locks when the quote is within 2% of the signed market price, and records what it checked', async () => {
    const proof = await response(20)
    const id = await lockWith(FAIR * 0.99, proof) // the agent keeps a 1% spread
    expect(await evm.htlc(id)).toMatchObject({ state: 'locked', amount: 100 * USDC })
    const client = createPublicClient({ chain: anvilChain, transport: http(node.rpcUrl) })
    const [quotedSats, fairSats, priceUsd18, priceTimestamp] = await client.readContract({ address: htlc, abi: GUARDED_HTLC_ABI, functionName: 'priceChecks', args: [`0x${id}`] }) as bigint[]
    expect({ quotedSats, fairSats, priceUsd18 }).toEqual({ quotedSats: BigInt(FAIR * 0.99), fairSats: BigInt(FAIR), priceUsd18: 20n * 10n ** 18n })
    expect(Number(priceTimestamp)).toBe(readPrice(proof).updatedAt)
  }, 60_000)

  it('refuses a quote more than 2% below the market (the donor would be short-changed)', async () => {
    await expect(lockWith(FAIR * 0.97, await response(20))).rejects.toThrow(/RateOutsideTolerance/)
  }, 60_000)

  it('refuses a quote more than 2% above the market too (bad or manipulated data on one side)', async () => {
    await expect(lockWith(FAIR * 1.03, await response(20))).rejects.toThrow(/RateOutsideTolerance/)
  }, 60_000)

  it('refuses a stale response and a stale price, even when correctly signed', async () => {
    await expect(lockWith(FAIR, await response(20, { age: 10 * 60 }))).rejects.toThrow(/ResponseTooOld/)
    await expect(lockWith(FAIR, await response(20, { priceAge: 60 * 60 }))).rejects.toThrow(/PriceTooOld/)
  }, 60_000)

  it('refuses data not signed by its Airnode, a response to another request, and tampered data', async () => {
    await expect(lockWith(FAIR, await response(20, { signer: impostor }))).rejects.toThrow(/NotSignedByAirnode/)
    const other = deriveRequestHash({ ...BSV_USD_REQUEST, parameters: { coin_id: 'btc-bitcoin', quotes: 'USD' } })
    await expect(lockWith(FAIR, await response(20, { requestHash: other }))).rejects.toThrow(/NotSignedByAirnode/)
    // Signed at $20, then edited to $10 so that a quote of half the sats would look fair.
    const signed = await response(20)
    const tampered = { ...signed, data: signed.data.replace('"price":20', '"price":10') }
    await expect(lockWith(FAIR * 2, tampered)).rejects.toThrow(/NotSignedByAirnode/)
  }, 60_000)

  it('has no unguarded way in: the plain lock() reverts', async () => {
    const plain = new EvmUsdcChain({ ...evm.opts, priceGuarded: false })
    await expect(plain.account(fay.address).lock({ receiver: lpAccount.address, amount: USDC, hashlock: newSecret().hashlock, refundAfter: (await now()) + 3600 })).rejects.toThrow(/UseLockWithPrice/)
    // And the adapter will not even try a guarded lock without a proof.
    await expect(evm.account(fay.address).lock({ receiver: lpAccount.address, amount: USDC, hashlock: newSecret().hashlock, refundAfter: (await now()) + 3600 })).rejects.toThrow(/priceProof/)
  }, 60_000)
})

describe.skipIf(anvilBinary() === undefined)('a REAL API3 AirnodeHub signature, verified by the contract', () => {
  let node: Anvil

  beforeAll(async () => { node = await startAnvil(undefined, { timestamp: Number(fixture.response.timestamp) + 10 }) }, 60_000)
  afterAll(async () => { await node?.stop() })

  it('our request hash matches the Airnode\'s, and PriceGuardedHTLC accepts Nodary\'s signature', async () => {
    // The hash we compute without calling the Airnode is the one it reported: so we can store it at deployment.
    expect(deriveRequestHash(fixture.request)).toBe(fixture.response.requestHash)
    await verifySignedResponse(fixture.response, fixture.response.airnode, fixture.response.requestHash)

    const { htlc } = await deployBridgeContracts(node.rpcUrl, anvilChain, deployer, {
      withTestToken: false,
      priceGuard: { airnode: fixture.response.airnode, requestHash: fixture.response.requestHash, ...DEFAULT_PRICE_GUARD, priceTime: 'millis' }
    })
    const client = createPublicClient({ chain: anvilChain, transport: http(node.rpcUrl) })
    const r = fixture.response
    const [price, priceTimestamp] = await client.readContract({
      address: htlc, abi: GUARDED_HTLC_ABI, functionName: 'checkedPrice', args: [BigInt(r.timestamp), `0x${Buffer.from(r.data).toString('hex')}`, r.signature]
    }) as [bigint, bigint]
    expect(price).toBe(BigInt(Math.round(readPrice(r).usd * 1000)) * 10n ** 15n) // e.g. 1.001 USD → 1.001e18
    expect(Number(priceTimestamp)).toBe(readPrice(r).updatedAt)
    // One changed byte and it is no longer API3's.
    await expect(client.readContract({
      address: htlc, abi: GUARDED_HTLC_ABI, functionName: 'checkedPrice', args: [BigInt(r.timestamp), `0x${Buffer.from(r.data.replace('1.0', '2.0')).toString('hex')}`, r.signature]
    })).rejects.toThrow(/NotSignedByAirnode/)
  }, 60_000)
})

describe.skipIf(anvilBinary() === undefined)('the USDC → BSV swap with the price guard', () => {
  let node: Anvil, evm: EvmUsdcChain, chain: MockChain, server: Server
  let lpWallet: Wallet
  const spendable = async (w: Wallet): Promise<number> => (await w.listOutputs({ basket: 'default', limit: 1000 })).outputs.filter(o => o.spendable).reduce((s, o) => s + o.satoshis, 0)
  const findSpend: SpendFinder = async (txid, vout) => {
    const storage = (chain.services as any).storage
    const row = await storage.knex('mockchain_utxos').where({ txid, vout }).first()
    if (row?.spentByTxid == null) return undefined
    return Transaction.fromBinary(Array.from((await storage.getTransaction(row.spentByTxid)).rawTx as number[]))
  }
  // BSV at $5,000 keeps the swap inside the mock wallet's inventory: 100 USDC ≈ 2,000,000 sats.
  const priceSource = async (): Promise<SignedResponse> => {
    const t = await evm.now()
    return await signAsAirnode(testAirnode, REQUEST_HASH, t, bsvUsdData(5000, t - 30))
  }

  beforeAll(async () => {
    node = await startAnvil()
    const d = await deployBridgeContracts(node.rpcUrl, anvilChain, deployer, { withTestToken: true, priceGuard: { airnode: testAirnode.address, requestHash: REQUEST_HASH, ...DEFAULT_PRICE_GUARD } })
    evm = new EvmUsdcChain({ name: 'USDC (local EVM chain, price-guarded)', rpcUrl: node.rpcUrl, chain: anvilChain, htlc: d.htlc, token: d.token!, signers: [fay, lpAccount], priceGuarded: true })
    await mintTestUsdc(node.rpcUrl, anvilChain, deployer, d.token!, fay.address, 300 * USDC)
    chain = await createMockChain()
    lpWallet = await chain.makeWallet()
    await chain.fund(lpWallet, 10_000_000)
    const db = new CryptoPledgePotDb(memoryKnex()); await db.migrate()
    const clock = await evm.now()
    await new Promise<void>(resolve => { server = createCryptoPledgePotApp({ wallet: lpWallet, db, chainTracker: chain.chainTracker, now: () => clock }).listen(0, () => resolve()) })
  }, 120_000)
  afterAll(async () => { await new Promise(r => server?.close(r)); await chain?.close(); await node?.stop() })

  it('an honest agent quotes from the signed price; the contract checks it and the swap completes', async () => {
    const lp = new LiquidityAgent(lpWallet, evm, lpAccount.address, findSpend, async () => await spendable(lpWallet), { ...DEFAULT_LIQUIDITY, priceSource, spreadBps: 50 })
    const wallet = await chain.makeWallet()
    const swap = new DonorSwap(wallet, evm, fay.address, chain.chainTracker)
    let r = await swap.requestQuote(lp, 100 * USDC)
    expect(r.quote.sats).toBe(1_990_000) // 2,000,000 at $5,000 minus the agent's 0.5%
    expect(r.quote.priceProof).toBeDefined()
    r = await swap.lockAndRequest(lp, r)
    expect(r.lock).toBeDefined()
    expect(await swap.verifyLock(r)).toEqual([])
    r = await swap.claim(r)
    expect(r.state).toBe('claimed')
    expect(await spendable(wallet)).toBeGreaterThan(1_990_000 - 2_000)
  }, 120_000)

  it('a greedy agent (5% below market) is stopped by the contract: the donor\'s USDC never move', async () => {
    const greedy = new LiquidityAgent(lpWallet, evm, lpAccount.address, findSpend, async () => await spendable(lpWallet), { ...DEFAULT_LIQUIDITY, priceSource, spreadBps: 500 })
    const swap = new DonorSwap(await chain.makeWallet(), evm, fay.address, chain.chainTracker)
    const before = await evm.account(fay.address).balance()
    const r = await swap.requestQuote(greedy, 100 * USDC)
    await expect(swap.lockAndRequest(greedy, r)).rejects.toThrow(/RateOutsideTolerance/)
    expect(await evm.account(fay.address).balance()).toBe(before)
  }, 120_000)
})
