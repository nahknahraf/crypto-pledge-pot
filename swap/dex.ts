/**
 * Real DEX routes for SwapAndLock: build the router call off-chain.
 *
 * Uniswap V3 SwapRouter02 `exactInputSingle`, with SwapAndLock as the recipient
 * (it then locks the USDC). Addresses below are Base mainnet; they are checked
 * on a fork in test/bridge.fork.test.ts (FORK_URL) before being relied on.
 */
import { encodeFunctionData, type Address, type Hex } from 'viem'

export const BASE = {
  USDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as Address,
  WETH: '0x4200000000000000000000000000000000000006' as Address,
  UNISWAP_V3_SWAP_ROUTER_02: '0x2626664c2603336E57B271c5C0b26F421741e481' as Address
}

const SWAP_ROUTER_02_ABI = [{
  type: 'function',
  name: 'exactInputSingle',
  stateMutability: 'payable',
  inputs: [{
    name: 'params',
    type: 'tuple',
    components: [
      { name: 'tokenIn', type: 'address' }, { name: 'tokenOut', type: 'address' }, { name: 'fee', type: 'uint24' },
      { name: 'recipient', type: 'address' }, { name: 'amountIn', type: 'uint256' }, { name: 'amountOutMinimum', type: 'uint256' },
      { name: 'sqrtPriceLimitX96', type: 'uint160' }
    ]
  }],
  outputs: [{ name: 'amountOut', type: 'uint256' }]
}] as const

/**
 * Calldata for SwapRouter02.exactInputSingle. `recipient` must be the SwapAndLock router.
 * `minOut` is a second guard; SwapAndLock itself requires at least the quoted USDC.
 */
export function uniswapV3ExactInputSingle (p: { tokenIn: Address, tokenOut: Address, fee: number, recipient: Address, amountIn: bigint, minOut?: bigint }): Hex {
  return encodeFunctionData({
    abi: SWAP_ROUTER_02_ABI,
    functionName: 'exactInputSingle',
    args: [{ tokenIn: p.tokenIn, tokenOut: p.tokenOut, fee: p.fee, recipient: p.recipient, amountIn: p.amountIn, amountOutMinimum: p.minOut ?? 0n, sqrtPriceLimitX96: 0n }]
  })
}
