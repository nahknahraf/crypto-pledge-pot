/**
 * DeFi sourcing on a real EVM chain: a donor who holds another token (not USDC)
 * swaps it on a DEX and locks exactly the quoted USDC, in ONE transaction,
 * through the SwapAndLock router. The DEX here is a fixed-rate TestDex.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Transaction } from '@bsv/sdk'
import type { Wallet } from '@bsv/wallet-toolbox'
import { encodeFunctionData, type Address } from 'viem'
import { anvil as anvilChain } from 'viem/chains'
import { anvilAccount, anvilBinary, startAnvil, type Anvil } from '../swap/anvil'
import type { SpendFinder } from '../swap/bsv'
import { DonorSwap } from '../swap/donorSwap'
import { deployBridgeContracts, deployTestDex, EvmUsdcChain, mintTestUsdc, TEST_DEX_ABI } from '../swap/evmChain'
import { LiquidityAgent } from '../swap/liquidityAgent'
import { USDC } from '../swap/usdcChain'
import { createMockChain, type MockChain } from './helpers/mockchain'

const deployer = anvilAccount(0); const fay = anvilAccount(1); const lpEvm = anvilAccount(2)
let node: Anvil, chain: MockChain, evm: EvmUsdcChain, tkn: EvmUsdcChain, router: Address, dex: Address, other: Address, lpWallet: Wallet
const spendable = async (w: Wallet): Promise<number> => (await w.listOutputs({ basket: 'default', limit: 1000 })).outputs.filter(o => o.spendable).reduce((s, o) => s + o.satoshis, 0)
const findSpend: SpendFinder = async (txid, vout) => {
  const storage = (chain.services as any).storage
  const row = await storage.knex('mockchain_utxos').where({ txid, vout }).first()
  return row?.spentByTxid == null ? undefined : Transaction.fromBinary(Array.from((await storage.getTransaction(row.spentByTxid)).rawTx as number[]))
}
const TKN = 1_000_000 // 6 decimals, like USDC
const swapVia = (amountIn: number, minOut = 0) => ({ router, tokenIn: other, amountIn: BigInt(amountIn), dex, dexCall: encodeFunctionData({ abi: TEST_DEX_ABI, functionName: 'swap', args: [other, evm.opts.token, BigInt(amountIn), BigInt(minOut)] }) })

describe.skipIf(anvilBinary() === undefined)('DeFi sourcing: swap another token and lock USDC in one transaction', () => {
  beforeAll(async () => {
    node = await startAnvil()
    const d = await deployBridgeContracts(node.rpcUrl, anvilChain, deployer, { withTestToken: true, withRouter: true })
    router = d.router!
    ;({ otherToken: other, dex } = await deployTestDex(node.rpcUrl, anvilChain, deployer, 2, 1)) // 1 TKN = 2 USDC
    evm = new EvmUsdcChain({ name: 'USDC (local EVM chain)', rpcUrl: node.rpcUrl, chain: anvilChain, htlc: d.htlc, token: d.token!, signers: [fay, lpEvm] })
    tkn = new EvmUsdcChain({ ...evm.opts, token: other }) // only to read TKN balances
    await mintTestUsdc(node.rpcUrl, anvilChain, deployer, other, fay.address, 100 * TKN)
    chain = await createMockChain()
    lpWallet = await chain.makeWallet(); await chain.fund(lpWallet, 3_000_000)
  }, 120_000)
  afterAll(async () => { await chain?.close(); await node?.stop() })

  it('Fay holds no USDC: 11 TKN become 22 USDC, exactly 20 are locked (refundable to HER), 2 come back; the swap completes', async () => {
    expect(await evm.account(fay.address).balance()).toBe(0)
    const lp = new LiquidityAgent(lpWallet, evm, lpEvm.address, findSpend, async () => await spendable(lpWallet))
    const bsvWallet = await chain.makeWallet()
    const swap = new DonorSwap(bsvWallet, evm, fay.address, chain.chainTracker)
    let r = await swap.requestQuote(lp, 20 * USDC)
    r = await swap.lockAndRequest(lp, r, async a => await evm.swapAndLock(fay.address, swapVia(11 * TKN), a))
    expect(await evm.htlc(r.sourceHtlcId!)).toMatchObject({ state: 'locked', amount: 20 * USDC, sender: fay.address, receiver: lpEvm.address })
    expect(await evm.account(fay.address).balance()).toBe(2 * USDC) // the surplus
    expect(await tkn.account(fay.address).balance()).toBe(89 * TKN)
    expect(r.lock?.satoshis).toBe(r.quote.sats)
    r = await swap.claim(r)
    expect(r.state).toBe('claimed')
    await lp.step()
    expect(lp.state(r.quote.id)).toBe('settled')
    expect(await evm.account(lpEvm.address).balance()).toBe(20 * USDC)
  }, 120_000)

  it('too little from the DEX: the whole transaction reverts and nothing moves', async () => {
    const before = await tkn.account(fay.address).balance()
    const { hashlock } = { hashlock: 'ab'.repeat(32) }
    await expect(evm.swapAndLock(fay.address, swapVia(9 * TKN), { receiver: lpEvm.address, amount: 20 * USDC, hashlock, refundAfter: (await evm.now()) + 3600 })).rejects.toThrow(/slippage/)
    expect(await tkn.account(fay.address).balance()).toBe(before)
  }, 120_000)

  it('the router refuses a "DEX" that is the HTLC or one of the tokens (no arbitrary calls on funds)', async () => {
    const bad = { ...swapVia(1 * TKN), dex: evm.opts.htlc }
    await expect(evm.swapAndLock(fay.address, bad, { receiver: lpEvm.address, amount: 1, hashlock: 'ab'.repeat(32), refundAfter: (await evm.now()) + 3600 })).rejects.toThrow(/dex/)
  }, 120_000)
})
