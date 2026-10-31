/**
 * The swap's failure paths on the REAL EVM contract (S11): the donor never
 * claims, and a liquidity agent that locks less than it quoted. The EVM
 * chain starts 30 days in the past so its clock and the BSV mock chain's
 * timelocks line up.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Transaction } from '@bsv/sdk'
import type { Wallet } from '@bsv/wallet-toolbox'
import { anvil as anvilChain } from 'viem/chains'
import { anvilAccount, anvilBinary, anvilIncreaseTime, startAnvil, type Anvil } from '../liquidity-agent/anvil'
import type { SpendFinder } from '../liquidity-agent/bsv'
import { DonorSwap } from '../liquidity-agent/donorSwap'
import { deployBridgeContracts, EvmUsdcChain, mintTestUsdc } from '../liquidity-agent/evmChain'
import { LiquidityAgent, type Quote } from '../liquidity-agent/liquidityAgent'
import { USDC } from '../liquidity-agent/usdcChain'
import { createMockChain, type MockChain } from './helpers/mockchain'

class ShortchangingAgent extends LiquidityAgent {
  protected override lockedAmount (quote: Quote): number { return quote.sats - 100_000 }
}

const deployer = anvilAccount(0); const donorEvm = anvilAccount(1); const lpEvm = anvilAccount(2)
let node: Anvil, evm: EvmUsdcChain, chain: MockChain, lpWallet: Wallet
const spendable = async (w: Wallet): Promise<number> => (await w.listOutputs({ basket: 'default', limit: 1000 })).outputs.filter(o => o.spendable).reduce((s, o) => s + o.satoshis, 0)
const findSpend: SpendFinder = async (txid, vout) => {
  const storage = (chain.services as any).storage
  const row = await storage.knex('mockchain_utxos').where({ txid, vout }).first()
  return row?.spentByTxid == null ? undefined : Transaction.fromBinary(Array.from((await storage.getTransaction(row.spentByTxid)).rawTx as number[]))
}

describe.skipIf(anvilBinary() === undefined)('swap failure paths on a real EVM chain', () => {
  beforeAll(async () => {
    node = await startAnvil(undefined, { timestamp: Math.floor(Date.now() / 1000) - 30 * 86_400 })
    const { htlc, token } = await deployBridgeContracts(node.rpcUrl, anvilChain, deployer, { withTestToken: true })
    evm = new EvmUsdcChain({ name: 'USDC (local EVM chain)', rpcUrl: node.rpcUrl, chain: anvilChain, htlc, token: token!, signers: [donorEvm, lpEvm] })
    await mintTestUsdc(node.rpcUrl, anvilChain, deployer, token!, donorEvm.address, 100 * USDC)
    chain = await createMockChain()
    lpWallet = await chain.makeWallet(); await chain.fund(lpWallet, 5_000_000)
  }, 120_000)
  afterAll(async () => { await chain?.close(); await node?.stop() })

  it('the donor never claims: the agent refunds its sats after T2, the donor refunds the USDC after T1, the agent never gets the USDC', async () => {
    const lp = new LiquidityAgent(lpWallet, evm, lpEvm.address, findSpend, async () => await spendable(lpWallet))
    const swap = new DonorSwap(await chain.makeWallet(), evm, donorEvm.address, chain.chainTracker)
    const lpSats = await spendable(lpWallet)
    let r = await swap.requestQuote(lp, 20 * USDC)
    r = await swap.lockAndRequest(lp, r)
    const t2 = r.lock!.terms.refundAfter
    const t1 = (await evm.htlc(r.sourceHtlcId!))!.refundAfter
    await anvilIncreaseTime(node.rpcUrl, t2 - (await evm.now()))
    await lp.step()
    expect(lp.state(r.quote.id)).toBe('refunded')
    expect(await spendable(lpWallet)).toBeGreaterThan(lpSats - 2_000)
    await expect(swap.refundSource(r)).rejects.toThrow(/early/)
    await anvilIncreaseTime(node.rpcUrl, t1 - (await evm.now()))
    await swap.refundSource(r)
    expect(await evm.account(donorEvm.address).balance()).toBe(100 * USDC)
    expect(await evm.account(lpEvm.address).balance()).toBe(0)
  }, 120_000)

  it('an agent that locks less than it quoted: the donor refuses to claim, and gets the USDC back after T1', async () => {
    const cheat = new ShortchangingAgent(lpWallet, evm, lpEvm.address, findSpend, async () => await spendable(lpWallet))
    const swap = new DonorSwap(await chain.makeWallet(), evm, donorEvm.address, chain.chainTracker)
    let r = await swap.requestQuote(cheat, 30 * USDC)
    r = await swap.lockAndRequest(cheat, r)
    r = await swap.claim(r)
    expect(r.state).toBe('refused')
    expect(r.steps.at(-1)).toMatch(/less than the quoted/)
    const t1 = (await evm.htlc(r.sourceHtlcId!))!.refundAfter
    await anvilIncreaseTime(node.rpcUrl, t1 - (await evm.now()))
    await swap.refundSource(r)
    expect(await evm.account(donorEvm.address).balance()).toBe(100 * USDC)
  }, 120_000)
})
