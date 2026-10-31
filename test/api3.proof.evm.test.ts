/**
 * The API3 proof judges re-run (npm run api3:judge), on a real EVM chain
 * (Anvil): the deployment record is checked against the contract's immutables,
 * and the tamper test as the API3 track defines it: a valid, timely response
 * locks for real, then an edited, a too-old, an other-request and a
 * wrong-signer response are each refused before the lock. A replayed lock is
 * refused too.
 *
 * Skipped if the anvil binary is not installed (dev dependency @foundry-rs/anvil).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createPublicClient, http, toHex, type Address, type PublicClient } from 'viem'
import { anvil as anvilChain } from 'viem/chains'
import { anvilAccount, anvilBinary, startAnvil, type Anvil } from '../swap/anvil'
import { BSV_USD_REQUEST, bsvUsdData, deriveRequestHash, signAsAirnode, type SignedResponse } from '../swap/api3Price'
import { BTC_USD_REQUEST, checkDeployment, formatTamperTest, readDeployment, runTamperTest, withPrice, writeDeployment, type Api3Deployment } from '../swap/api3Proof'
import { DEFAULT_PRICE_GUARD, deployBridgeContracts, EvmUsdcChain, mintTestUsdc } from '../swap/evmChain'
import { USDC } from '../swap/usdcChain'

const deployer = anvilAccount(0)
const testAirnode = anvilAccount(9)
const locker = anvilAccount(1)
const REQUEST_HASH = deriveRequestHash(BSV_USD_REQUEST)

describe.skipIf(anvilBinary() === undefined)('API3 proof: deployment record and tamper test', () => {
  let node: Anvil, client: PublicClient, record: Api3Deployment, token: Address
  const fresh = async (usd = 17.45): Promise<SignedResponse> => {
    const t = Number((await client.getBlock()).timestamp)
    return await signAsAirnode(testAirnode, REQUEST_HASH, t - 5, bsvUsdData(usd, t - 60))
  }
  const inputs = async (): Promise<{ valid: SignedResponse, stale: SignedResponse, otherRequest: SignedResponse }> => {
    const t = Number((await client.getBlock()).timestamp)
    return {
      valid: await fresh(),
      stale: await signAsAirnode(testAirnode, REQUEST_HASH, t - 3600, bsvUsdData(17.6, t - 3660)),
      otherRequest: await signAsAirnode(testAirnode, deriveRequestHash(BTC_USD_REQUEST), t - 5, bsvUsdData(68_250, t - 60))
    }
  }

  beforeAll(async () => {
    node = await startAnvil()
    client = createPublicClient({ chain: anvilChain, transport: http(node.rpcUrl) })
    const d = await deployBridgeContracts(node.rpcUrl, anvilChain, deployer, { withTestToken: true, priceGuard: { airnode: testAirnode.address, requestHash: REQUEST_HASH, ...DEFAULT_PRICE_GUARD } })
    token = d.token!
    await mintTestUsdc(node.rpcUrl, anvilChain, deployer, token, locker.address, 100 * USDC)
    record = {
      contract: 'PriceGuardedHTLC', network: 'Anvil', chainId: anvilChain.id, rpcUrl: node.rpcUrl, address: d.htlc, deployTx: d.htlcTx, blockNumber: d.htlcBlock,
      deployer: deployer.address, deployedAt: new Date().toISOString(), token, airnode: testAirnode.address, requestHash: REQUEST_HASH, request: BSV_USD_REQUEST,
      maxDeviationBps: DEFAULT_PRICE_GUARD.maxDeviationBps, maxResponseAge: DEFAULT_PRICE_GUARD.maxResponseAge, maxPriceAge: DEFAULT_PRICE_GUARD.maxPriceAge
    }
  }, 120_000)
  afterAll(async () => { await node?.stop() })

  it('the deployment record round-trips and matches the contract on chain; a false record is caught', async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'api3-')), 'api3-price-guard.json')
    writeDeployment(record, file)
    expect(readDeployment(file)).toEqual(record)
    expect(await checkDeployment(client, record)).toEqual([])
    // A local guard trusts a test key, not CoinPaprika: the judge's check says so.
    expect((await checkDeployment(client, record, { expectCoinPaprika: true })).join()).toMatch(/not CoinPaprika/)
    expect((await checkDeployment(client, { ...record, maxDeviationBps: 50 })).join()).toMatch(/maxDeviationBps on chain is 200/)
    expect((await checkDeployment(client, { ...record, address: token })).join()).toMatch(/is not a PriceGuardedHTLC/)
  }, 60_000)

  it('tamper test: a valid response locks for real; the four required tampered responses are refused before the lock', async () => {
    const before = await new EvmUsdcChain({ name: 'evm', rpcUrl: node.rpcUrl, chain: anvilChain, htlc: record.address, token, signers: [] }).account(locker.address).balance()
    const cases = await runTamperTest(client, record.address, token, await inputs(), { locker, chain: anvilChain, rpcUrl: node.rpcUrl })
    expect(cases.map(c => [c.name, c.got, c.pass])).toEqual([
      ['Valid, timely response', 'locked', true],
      ['Real response, one value edited', 'NotSignedByAirnode', true],
      ['Real response, too old', 'ResponseTooOld', true],
      ['Real response, different request', 'NotSignedByAirnode', true],
      ['Signed by a key that is not the Airnode\'s', 'NotSignedByAirnode', true]
    ])
    expect(cases[0].tx).toMatch(/^0x[0-9a-f]{64}$/)
    // Exactly one lock moved tokens: the valid one (1 USDC).
    const after = await new EvmUsdcChain({ name: 'evm', rpcUrl: node.rpcUrl, chain: anvilChain, htlc: record.address, token, signers: [] }).account(locker.address).balance()
    expect(before - after).toBe(USDC)
    expect(formatTamperTest(cases)).toMatch(/PASS: 1 valid response locked, 4 tampered responses rejected/)
  }, 60_000)

  it('the rejections can be sent as transactions, so their reverts are on the explorer', async () => {
    const cases = await runTamperTest(client, record.address, token, await inputs(), { locker, chain: anvilChain, rpcUrl: node.rpcUrl, sendRejections: true })
    expect(cases.every(c => c.pass && c.tx !== undefined)).toBe(true)
    for (const c of cases.slice(1)) expect((await client.getTransactionReceipt({ hash: c.tx! })).status).toBe('reverted')
  }, 60_000)

  it('without a key, the valid case is a read-only check and never claims a lock', async () => {
    const cases = await runTamperTest(client, record.address, token, await inputs())
    expect(cases[0]).toMatchObject({ got: 'accepted', pass: true })
    expect(cases[0].tx).toBeUndefined()
    expect(cases.slice(1).every(c => c.pass)).toBe(true)
    expect(formatTamperTest(cases)).toMatch(/PASS: 1 valid response accepted \(read-only, nothing locked\)/)
  }, 60_000)

  it('reports honestly when a response is missing or the judge\'s own response is stale', async () => {
    const { stale } = await inputs()
    const cases = await runTamperTest(client, record.address, token, { valid: stale })
    expect(cases[0]).toMatchObject({ got: 'ResponseTooOld', pass: false })
    expect(cases[2]).toMatchObject({ got: 'missing', pass: false })
    expect(formatTamperTest(cases)).toMatch(/^FAIL/m)
  }, 60_000)

  it('refuses to lock the same swap (hashlock) twice: no duplicate execution', async () => {
    const evm = new EvmUsdcChain({ name: 'evm', rpcUrl: node.rpcUrl, chain: anvilChain, htlc: record.address, token, signers: [locker], priceGuarded: true })
    const proof = await fresh(20)
    const lock = async (): Promise<string> => await evm.account(locker.address).lock({ receiver: locker.address, amount: USDC, hashlock: toHex(7n, { size: 32 }).slice(2), refundAfter: Number((await client.getBlock()).timestamp) + 3600, quotedSats: 5_000_000, priceProof: proof })
    await lock()
    await expect(lock()).rejects.toThrow(/HashlockAlreadyUsed/)
  }, 60_000)

  it('withPrice edits only the price', () => {
    expect(withPrice('{"price":17.452224207521592,"updatedAt":"2026-10-31T01:50:20Z"}', 8.7)).toBe('{"price":8.7,"updatedAt":"2026-10-31T01:50:20Z"}')
  })
})
