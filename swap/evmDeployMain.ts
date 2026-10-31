/**
 * npm run evm:deploy: deploy the HashedTimelockERC20 contract to an EVM chain.
 *
 *   BRIDGE_RPC_URL=… BRIDGE_DEPLOYER_KEY=0x… [BRIDGE_CHAIN=base-sepolia|anvil] npm run evm:deploy
 *
 * Testnets and local chains only until the contract has been reviewed
 * (docs/BRIDGING_PLAN.md, step 1c). Prints the address to use as BRIDGE_HTLC.
 */
import '../core/loadEnv'
import type { Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { anvil, baseSepolia } from 'viem/chains'
import { deployBridgeContracts } from './evmChain'

const rpc = process.env.BRIDGE_RPC_URL ?? ''
const key = process.env.BRIDGE_DEPLOYER_KEY ?? ''
if (rpc === '' || key === '') { console.error('set BRIDGE_RPC_URL and BRIDGE_DEPLOYER_KEY'); process.exit(1) }
const chain = process.env.BRIDGE_CHAIN === 'anvil' ? anvil : baseSepolia
const { htlc } = await deployBridgeContracts(rpc, chain, privateKeyToAccount(key as Hex), { withTestToken: false })
console.log(`HashedTimelockERC20 deployed on ${chain.name}: ${htlc}`)
