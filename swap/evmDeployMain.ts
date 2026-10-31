/**
 * npm run evm:deploy: deploy the swap's HTLC to an EVM chain.
 *
 *   BRIDGE_RPC_URL=… BRIDGE_DEPLOYER_KEY=0x… [BRIDGE_CHAIN=base-sepolia|anvil] npm run evm:deploy
 *
 * With BRIDGE_PRICE_GUARD=api3 it deploys PriceGuardedHTLC instead: locks must
 * carry a BSV/USD response signed by CoinPaprika's Airnode on API3 AirnodeHub,
 * and are refused if the quote is more than API3_MAX_DEVIATION_BPS (default
 * 200 = 2%) away from it. API3_AIRNODE / API3_REQUEST_HASH override the
 * signer and request (defaults: CoinPaprika, BSV_USD_REQUEST).
 *
 * API3_TEST_TOKEN=1 also deploys TestUSDC (anyone can mint it) and records it
 * as the token to lock, so the tamper test's real lock needs no USDC faucet.
 *
 * The guarded deployment is recorded in deployments/api3-price-guard.json
 * (network, address, deploy tx, settings, a public RPC): commit it, it is the
 * proof judges check with `npm run api3:judge` and `npm run evm:verify`.
 *
 * Testnets and local chains only until the contract has been reviewed
 * (docs/BRIDGING_PLAN.md, step 1c). Prints the address to use as BRIDGE_HTLC.
 */
import type { Address, Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { anvil, baseSepolia } from 'viem/chains'
import { BSV_USD_REQUEST, COINPAPRIKA_AIRNODE_ADDRESS, deriveRequestHash } from './api3Price'
import { DEPLOYMENT_FILE, PUBLIC_NETWORKS, writeDeployment } from './api3Proof'
import { DEFAULT_PRICE_GUARD, deployBridgeContracts, type PriceGuardSettings } from './evmChain'

const env = process.env
const rpc = env.BRIDGE_RPC_URL ?? ''
const key = env.BRIDGE_DEPLOYER_KEY ?? ''
if (rpc === '' || key === '') { console.error('set BRIDGE_RPC_URL and BRIDGE_DEPLOYER_KEY'); process.exit(1) }
const chain = env.BRIDGE_CHAIN === 'anvil' ? anvil : baseSepolia
const priceGuard: PriceGuardSettings | undefined = env.BRIDGE_PRICE_GUARD === 'api3'
  ? {
      ...DEFAULT_PRICE_GUARD,
      airnode: (env.API3_AIRNODE ?? COINPAPRIKA_AIRNODE_ADDRESS) as Address,
      requestHash: (env.API3_REQUEST_HASH ?? deriveRequestHash(BSV_USD_REQUEST)) as Hex,
      maxDeviationBps: Number(env.API3_MAX_DEVIATION_BPS ?? DEFAULT_PRICE_GUARD.maxDeviationBps)
    }
  : undefined
const deployer = privateKeyToAccount(key as Hex)
const withTestToken = priceGuard !== undefined && env.API3_TEST_TOKEN === '1'
const { htlc, htlcTx, htlcBlock, token: testToken } = await deployBridgeContracts(rpc, chain, deployer, { withTestToken, priceGuard, confirmations: chain.id === anvil.id ? 1 : 2 })
console.log(`${priceGuard !== undefined ? 'PriceGuardedHTLC' : 'HashedTimelockERC20'} deployed on ${chain.name}: ${htlc} (tx ${htlcTx})`)
if (priceGuard !== undefined) {
  console.log(`  airnode ${priceGuard.airnode} · request ${priceGuard.requestHash} · max deviation ${priceGuard.maxDeviationBps / 100}%`)
  const pub = PUBLIC_NETWORKS[chain.id]
  writeDeployment({
    contract: 'PriceGuardedHTLC',
    network: chain.name,
    chainId: chain.id,
    rpcUrl: pub?.rpcUrl ?? rpc,
    address: htlc,
    deployTx: htlcTx,
    blockNumber: htlcBlock,
    deployer: deployer.address,
    deployedAt: new Date().toISOString(),
    explorer: pub !== undefined ? pub.explorer + htlc : undefined,
    token: (testToken ?? env.BRIDGE_TOKEN ?? pub?.usdc ?? '0x0000000000000000000000000000000000000000') as Address,
    testToken: testToken !== undefined ? true : undefined,
    airnode: priceGuard.airnode,
    requestHash: priceGuard.requestHash,
    request: BSV_USD_REQUEST,
    maxDeviationBps: priceGuard.maxDeviationBps,
    maxResponseAge: priceGuard.maxResponseAge,
    maxPriceAge: priceGuard.maxPriceAge
  })
  console.log(`  recorded in ${DEPLOYMENT_FILE}; next: npm run evm:verify (source on Sourcify), then npm run api3:judge`)
}
