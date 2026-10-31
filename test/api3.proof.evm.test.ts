/**
 * The API3 proof judges re-run (npm run api3:judge), on a real EVM chain
 * (Anvil): the deployment record is checked against the contract's immutables,
 * and the tamper test gives one accepted and four rejected submissions, each
 * with the contract's own error.
 *
 * Skipped if the anvil binary is not installed (dev dependency @foundry-rs/anvil).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createPublicClient, http, type Address, type PublicClient } from 'viem'
import { anvil as anvilChain } from 'viem/chains'
import { anvilAccount, anvilBinary, startAnvil, type Anvil } from '../swap/anvil'
import { BSV_USD_REQUEST, bsvUsdData, deriveRequestHash, signAsAirnode, type SignedResponse } from '../swap/api3Price'
import { checkDeployment, FOREIGN_API3_RESPONSE, formatTamperTest, readDeployment, runTamperTest, withPrice, writeDeployment, type Api3Deployment } from '../swap/api3Proof'
import { DEFAULT_PRICE_GUARD, deployBridgeContracts } from '../swap/evmChain'

const deployer = anvilAccount(0)
const testAirnode = anvilAccount(9)
const REQUEST_HASH = deriveRequestHash(BSV_USD_REQUEST)

describe.skipIf(anvilBinary() === undefined)('API3 proof: deployment record and tamper test', () => {
  let node: Anvil, client: PublicClient, record: Api3Deployment, token: Address
  const fresh = async (usd = 17.45): Promise<SignedResponse> => {
    const t = Number((await client.getBlock()).timestamp)
    return await signAsAirnode(testAirnode, REQUEST_HASH, t - 5, bsvUsdData(usd, t - 60))
  }

  beforeAll(async () => {
    node = await startAnvil()
    client = createPublicClient({ chain: anvilChain, transport: http(node.rpcUrl) })
    const d = await deployBridgeContracts(node.rpcUrl, anvilChain, deployer, { withTestToken: true, priceGuard: { airnode: testAirnode.address, requestHash: REQUEST_HASH, ...DEFAULT_PRICE_GUARD } })
    token = d.token!
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

  it('tamper test: the signed response is accepted, four manipulations are refused by the contract', async () => {
    const cases = await runTamperTest(client, record.address, token, await fresh())
    expect(cases.map(c => [c.got, c.pass])).toEqual([
      ['accepted', true],
      ['NotSignedByAirnode', true],
      ['NotSignedByAirnode', true],
      ['NotSignedByAirnode', true],
      ['RateOutsideTolerance', true]
    ])
    expect(formatTamperTest(cases)).toMatch(/1 accepted, 4 rejected: exactly as expected/)
  }, 60_000)

  it('reports honestly when the judge\'s own response is stale or foreign', async () => {
    const t = Number((await client.getBlock()).timestamp)
    const stale = await signAsAirnode(testAirnode, REQUEST_HASH, t - 3600, bsvUsdData(17.45, t - 3600))
    const [first] = await runTamperTest(client, record.address, token, stale)
    expect(first).toMatchObject({ got: 'ResponseTooOld', pass: false })
    const [foreign] = await runTamperTest(client, record.address, token, FOREIGN_API3_RESPONSE)
    expect(foreign).toMatchObject({ got: 'NotSignedByAirnode', pass: false })
  }, 60_000)

  it('withPrice edits only the price', () => {
    expect(withPrice('{"price":17.452224207521592,"updatedAt":"2026-10-31T01:50:20Z"}', 8.7)).toBe('{"price":8.7,"updatedAt":"2026-10-31T01:50:20Z"}')
  })
})
