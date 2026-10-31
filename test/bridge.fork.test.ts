/**
 * Opt-in (FORK_URL, e.g. https://mainnet.base.org): the bridge against REAL
 * contracts on a local fork of Base. Real USDC (with its real permit), real
 * WETH, real Uniswap V3. Our HTLC and SwapAndLock are deployed on the fork.
 * Nothing touches the real network: Anvil only reads state from it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Transaction } from '@bsv/sdk'
import type { Wallet } from '@bsv/wallet-toolbox'
import { createPublicClient, createWalletClient, http, parseAbi, type Address } from 'viem'
import { base as anvilChain } from 'viem/chains' // the fork keeps Base's chain id (8453), as USDC's permit domain expects
import { anvilAccount, anvilBinary, anvilSetBalance, startAnvil, type Anvil } from '../swap/anvil'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import type { SpendFinder } from '../swap/bsv'
import { BASE, uniswapV3ExactInputSingle } from '../swap/dex'
import { DonorSwap } from '../swap/donorSwap'
import { deployBridgeContracts, EvmUsdcChain } from '../swap/evmChain'
import { newSecret } from '../core/swap'
import { LiquidityAgent } from '../swap/liquidityAgent'
import { USDC } from '../swap/usdcChain'
import { createMockChain, type MockChain } from './helpers/mockchain'

const FORK = process.env.FORK_URL ?? ''
const deployer = anvilAccount(0); const fay = anvilAccount(1); const lpEvm = anvilAccount(2)
const ERC20 = parseAbi(['function symbol() view returns (string)', 'function decimals() view returns (uint8)', 'function deposit() payable', 'function WETH9() view returns (address)'])
let node: Anvil, chain: MockChain, evm: EvmUsdcChain, router: Address
const spendable = async (w: Wallet): Promise<number> => (await w.listOutputs({ basket: 'default', limit: 1000 })).outputs.filter(o => o.spendable).reduce((s, o) => s + o.satoshis, 0)
const findSpend: SpendFinder = async (txid, vout) => {
  const storage = (chain.services as any).storage
  const row = await storage.knex('mockchain_utxos').where({ txid, vout }).first()
  return row?.spentByTxid == null ? undefined : Transaction.fromBinary(Array.from((await storage.getTransaction(row.spentByTxid)).rawTx as number[]))
}

describe.skipIf(FORK === '' || anvilBinary() === undefined)('the bridge against real Base contracts (fork)', () => {
  beforeAll(async () => {
    node = await startAnvil(undefined, { forkUrl: FORK })
    ;({ htlc: evm, router } = await (async () => {
      const d = await deployBridgeContracts(node.rpcUrl, anvilChain, deployer, { withTestToken: false, withRouter: true })
      return { htlc: new EvmUsdcChain({ name: 'USDC on a Base fork', rpcUrl: node.rpcUrl, chain: anvilChain, htlc: d.htlc, token: BASE.USDC, signers: [fay, lpEvm] }), router: d.router! }
    })())
    chain = await createMockChain()
  }, 300_000)
  afterAll(async () => { await chain?.close(); await node?.stop() })

  it('the addresses are what we think they are', async () => {
    const pub = createPublicClient({ chain: anvilChain, transport: http(node.rpcUrl) })
    expect(await pub.readContract({ address: BASE.USDC, abi: ERC20, functionName: 'symbol' })).toBe('USDC')
    expect(await pub.readContract({ address: BASE.USDC, abi: ERC20, functionName: 'decimals' })).toBe(6)
    expect(await pub.readContract({ address: BASE.WETH, abi: ERC20, functionName: 'symbol' })).toBe('WETH')
    expect((await pub.readContract({ address: BASE.UNISWAP_V3_SWAP_ROUTER_02, abi: ERC20, functionName: 'WETH9' })).toLowerCase()).toBe(BASE.WETH.toLowerCase())
  }, 300_000)

  it('ETH → WETH → (real Uniswap) → exactly 20 real USDC locked for the LP, refundable to Fay; the swap completes into sats', async () => {
    const pub = createPublicClient({ chain: anvilChain, transport: http(node.rpcUrl) })
    const w = createWalletClient({ account: fay, chain: anvilChain, transport: http(node.rpcUrl) })
    await pub.waitForTransactionReceipt({ hash: await w.writeContract({ address: BASE.WETH, abi: ERC20, functionName: 'deposit', value: 50_000_000_000_000_000n }) }) // 0.05 ETH
    const lpWallet = await chain.makeWallet(); await chain.fund(lpWallet, 3_000_000)
    const lp = new LiquidityAgent(lpWallet, evm, lpEvm.address, findSpend, async () => await spendable(lpWallet))
    const swap = new DonorSwap(await chain.makeWallet(), evm, fay.address, chain.chainTracker)
    let r = await swap.requestQuote(lp, 20 * USDC)
    const amountIn = 50_000_000_000_000_000n
    r = await swap.lockAndRequest(lp, r, async a => await evm.swapAndLock(fay.address, { router, tokenIn: BASE.WETH, amountIn, dex: BASE.UNISWAP_V3_SWAP_ROUTER_02, dexCall: uniswapV3ExactInputSingle({ tokenIn: BASE.WETH, tokenOut: BASE.USDC, fee: 500, recipient: router, amountIn }) }, a))
    expect(await evm.htlc(r.sourceHtlcId!)).toMatchObject({ state: 'locked', amount: 20 * USDC, sender: fay.address })
    expect(await evm.account(fay.address).balance()).toBeGreaterThan(0) // the surplus USDC
    r = await swap.claim(r)
    expect(r.state).toBe('claimed')
    await lp.step()
    expect(lp.state(r.quote.id)).toBe('settled')
    expect(await evm.account(lpEvm.address).balance()).toBe(20 * USDC)
  }, 300_000)

  it('real USDC: a plain account locks with ONE transaction (permit); an EIP-7702 delegated one falls back to approve + lock', async () => {
    const pub = createPublicClient({ chain: anvilChain, transport: http(node.rpcUrl) })
    // Anvil's dev keys are public, and on Base their addresses carry EIP-7702 delegations: Fay is one of them.
    expect((await pub.getCode({ address: fay.address })) ?? '0x').not.toBe('0x')
    const fresh = privateKeyToAccount(generatePrivateKey())
    await anvilSetBalance(node.rpcUrl, fresh.address, 10n ** 18n)
    // Give the fresh account 2 of Fay's USDC (left over from the swap above).
    const pay = createWalletClient({ account: fay, chain: anvilChain, transport: http(node.rpcUrl) })
    await pub.waitForTransactionReceipt({ hash: await pay.writeContract({ address: BASE.USDC, abi: parseAbi(['function transfer(address,uint256) returns (bool)']), functionName: 'transfer', args: [fresh.address, BigInt(2 * USDC)] }) })
    const withPermit = new EvmUsdcChain({ ...evm.opts, signers: [fay, fresh], permit: true })
    for (const [who, txs] of [[fresh, 1], [fay, 2]] as const) {
      const before = await pub.getTransactionCount({ address: who.address })
      const id = await withPermit.account(who.address).lock({ receiver: lpEvm.address, amount: 1 * USDC, hashlock: newSecret().hashlock, refundAfter: (await evm.now()) + 3600 })
      expect(await pub.getTransactionCount({ address: who.address }) - before, who.address).toBe(txs)
      expect(await evm.htlc(id)).toMatchObject({ state: 'locked', amount: 1 * USDC })
    }
  }, 300_000)
})
