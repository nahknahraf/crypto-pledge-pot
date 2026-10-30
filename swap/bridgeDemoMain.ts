/**
 * npm run demo:bridge: the bridge's happy path with a real EVM HTLC.
 *
 * Default: starts a local Anvil chain, deploys the HTLC and a test USDC, and
 * runs the swap into a pledge. Nothing leaves this machine.
 *
 * Public testnet (UNTESTED here: needs funded test accounts), set all of:
 *   BRIDGE_RPC_URL     e.g. a Base Sepolia RPC endpoint
 *   BRIDGE_HTLC        address of a deployed HashedTimelockERC20
 *   BRIDGE_TOKEN       the test USDC address (check Circle's docs for the current one)
 *   BRIDGE_DONOR_KEY   0x… testnet-only private key holding the USDC and some ETH for gas
 *   BRIDGE_LP_KEY      0x… testnet-only private key with some ETH for gas
 *   BRIDGE_USDC        amount in USDC (default 1)
 * Never put a mainnet key here. The BSV side is always the offline mock chain in this demo.
 */
import type { Address, Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { baseSepolia } from 'viem/chains'
import { runBridgeDemo, type PublicEvm } from './bridgeDemo'
import { USDC } from './usdcChain'

const env = process.env
let publicEvm: PublicEvm | undefined
if (env.BRIDGE_RPC_URL !== undefined && env.BRIDGE_RPC_URL !== '') {
  for (const k of ['BRIDGE_HTLC', 'BRIDGE_TOKEN', 'BRIDGE_DONOR_KEY', 'BRIDGE_LP_KEY']) {
    if ((env[k] ?? '') === '') { console.error(`${k} is required with BRIDGE_RPC_URL`); process.exit(1) }
  }
  publicEvm = {
    name: 'USDC on Base Sepolia',
    rpcUrl: env.BRIDGE_RPC_URL,
    chain: baseSepolia,
    htlc: env.BRIDGE_HTLC as Address,
    token: env.BRIDGE_TOKEN as Address,
    donor: privateKeyToAccount(env.BRIDGE_DONOR_KEY as Hex),
    lp: privateKeyToAccount(env.BRIDGE_LP_KEY as Hex),
    confirmations: 2
  }
}
const usdc = publicEvm === undefined ? 100 * USDC : Math.round(Number(env.BRIDGE_USDC ?? 1) * USDC)

await runBridgeDemo({ paceMs: Number(env.DEMO_PACE_S ?? 2) * 1000, usdc, publicEvm })
console.log(`\nDone. The other chain was ${publicEvm === undefined ? 'a local EVM chain (Anvil) with a real Solidity HTLC' : publicEvm.name}; the BSV side ran on the offline mock chain.`)
process.exit(0) // the mock chain's storage keeps timers alive
