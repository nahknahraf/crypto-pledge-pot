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
 * Testnets and local chains only until the contract has been reviewed
 * (docs/BRIDGING_PLAN.md, step 1c). Prints the address to use as BRIDGE_HTLC.
 */
import type { Address, Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { anvil, baseSepolia } from 'viem/chains'
import { BSV_USD_REQUEST, COINPAPRIKA_AIRNODE_ADDRESS, deriveRequestHash } from './api3Price'
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
const { htlc } = await deployBridgeContracts(rpc, chain, privateKeyToAccount(key as Hex), { withTestToken: false, priceGuard })
console.log(`${priceGuard !== undefined ? 'PriceGuardedHTLC' : 'HashedTimelockERC20'} deployed on ${chain.name}: ${htlc}`)
if (priceGuard !== undefined) console.log(`  airnode ${priceGuard.airnode} · request ${priceGuard.requestHash} · max deviation ${priceGuard.maxDeviationBps / 100}%`)
