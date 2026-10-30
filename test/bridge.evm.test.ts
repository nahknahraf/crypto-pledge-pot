/**
 * The swap with a REAL other chain: an ERC-20 HTLC (Solidity) on a local EVM
 * chain (Foundry's Anvil), driven through viem, against the sCrypt AtomicSwap
 * on the BSV mock chain. Same DonorSwap and LiquidityAgent as the simulated
 * version; only the SourceChain changes.
 *
 * Skipped if the anvil binary is not installed (dev dependency @foundry-rs/anvil).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import { Transaction } from '@bsv/sdk'
import type { Wallet } from '@bsv/wallet-toolbox'
import { anvil as anvilChain } from 'viem/chains'
import { CryptoPledgePot } from '../client/cryptoPledgePot'
import { CryptoPledgePotApi } from '../client/cryptoPledgePotApi'
import { newSecret } from '../core/swap'
import { createCryptoPledgePotApp } from '../server/app'
import { CryptoPledgePotDb } from '../server/db'
import { anvilAccount, anvilBinary, anvilIncreaseTime, anvilMine, startAnvil, type Anvil } from '../swap/anvil'
import type { SpendFinder } from '../swap/bsv'
import { DonorSwap } from '../swap/donorSwap'
import { deployBridgeContracts, EvmUsdcChain, mintTestUsdc } from '../swap/evmChain'
import { DEFAULT_LIQUIDITY, LiquidityAgent } from '../swap/liquidityAgent'
import { USDC } from '../swap/usdcChain'
import { createMockChain, memoryKnex, type MockChain } from './helpers/mockchain'

const deployer = anvilAccount(0)
const fay = anvilAccount(1)
const lpAccount = anvilAccount(2)
const stranger = anvilAccount(3)
let node: Anvil, evm: EvmUsdcChain, chain: MockChain, server: Server, url: string
let lpWallet: Wallet, lp: LiquidityAgent

const spendable = async (w: Wallet): Promise<number> => (await w.listOutputs({ basket: 'default', limit: 1000 })).outputs.filter(o => o.spendable).reduce((s, o) => s + o.satoshis, 0)
const findSpend: SpendFinder = async (txid, vout) => {
  const storage = (chain.services as any).storage
  const row = await storage.knex('mockchain_utxos').where({ txid, vout }).first()
  if (row?.spentByTxid == null) return undefined
  return Transaction.fromBinary(Array.from((await storage.getTransaction(row.spentByTxid)).rawTx as number[]))
}

describe.skipIf(anvilBinary() === undefined)('bridge on a real EVM chain (Anvil)', () => {
  beforeAll(async () => {
    node = await startAnvil()
    const { htlc, token } = await deployBridgeContracts(node.rpcUrl, anvilChain, deployer, { withTestToken: true })
    evm = new EvmUsdcChain({ name: 'USDC (local EVM chain)', rpcUrl: node.rpcUrl, chain: anvilChain, htlc, token: token!, signers: [fay, lpAccount, stranger] })
    await mintTestUsdc(node.rpcUrl, anvilChain, deployer, token!, fay.address, 150 * USDC)

    chain = await createMockChain()
    lpWallet = await chain.makeWallet()
    await chain.fund(lpWallet, 10_000_000)
    lp = new LiquidityAgent(lpWallet, evm, lpAccount.address, findSpend, async () => await spendable(lpWallet))
    const db = new CryptoPledgePotDb(memoryKnex()); await db.migrate()
    const arbiter = await chain.makeWallet()
    const clock = await evm.now()
    await new Promise<void>(resolve => { server = createCryptoPledgePotApp({ wallet: arbiter, db, chainTracker: chain.chainTracker, now: () => clock }).listen(0, () => resolve()) })
    url = `http://127.0.0.1:${(server.address() as any).port}`
  }, 120_000)
  afterAll(async () => { await new Promise(r => server?.close(r)); await chain?.close(); await node?.stop() })

  it('happy path: 100 USDC on the EVM chain become sats in Fay\'s own BSV wallet, then a pledge', async () => {
    const wallet = await chain.makeWallet()
    const swap = new DonorSwap(wallet, evm, fay.address, chain.chainTracker)
    expect(await spendable(wallet)).toBe(0)

    let r = await swap.requestQuote(lp, 100 * USDC)
    expect(r.quote.sats).toBe(2_150_000)
    r = await swap.lockAndRequest(lp, r)
    expect(r.lock).toBeDefined()
    const onEvm = await evm.htlc(r.sourceHtlcId!)
    expect(onEvm).toMatchObject({ state: 'locked', amount: 100 * USDC, hashlock: r.hashlock, receiver: lpAccount.address })
    expect(await evm.account(fay.address).balance()).toBe(50 * USDC) // locked in the contract, not given away
    expect(await swap.verifyLock(r)).toEqual([])

    r = await swap.claim(r)
    expect(r.state).toBe('claimed')
    expect(await spendable(wallet)).toBeGreaterThan(2_150_000 - 2_000)

    await lp.step() // reads the secret from Fay's BSV claim, claims the USDC on the EVM chain
    expect(lp.state(r.quote.id)).toBe('settled')
    expect(await evm.account(lpAccount.address).balance()).toBe(100 * USDC)
    expect(await evm.htlc(r.sourceHtlcId!)).toMatchObject({ state: 'claimed', secret: r.secret }) // public in the Claimed event

    const creator = await chain.makeWallet(); await chain.fund(creator, 50_000)
    const now = await evm.now()
    const { meta } = await new CryptoPledgePot(creator, new CryptoPledgePotApi(url, creator)).launch({
      title: 'Clean water for Kitui', description: 'One well, published water tests.', goal: 1_000_000, deadline: now + 7 * 86_400, refundAfter: now + 40 * 86_400,
      milestones: [{ title: 'Drill', percent: 60 }, { title: 'Publish tests', percent: 40 }]
    })
    const pledge = await new CryptoPledgePot(wallet, new CryptoPledgePotApi(url, wallet)).donate(meta, 1_000_000, { name: 'Fay', message: 'Came over from USDC on an EVM chain' })
    expect(pledge).toMatchObject({ amount: 1_000_000, status: 'active' })
  }, 120_000)

  it('the refund path is real too: an expired quote, and Fay takes her USDC back after T1 (not before)', async () => {
    const swap = new DonorSwap(await chain.makeWallet(), evm, fay.address, chain.chainTracker)
    let r = await swap.requestQuote(lp, 50 * USDC)
    await anvilIncreaseTime(node.rpcUrl, DEFAULT_LIQUIDITY.quoteValidity + 1)
    r = await swap.lockAndRequest(lp, r)
    expect(r.lock).toBeUndefined()
    expect(r.steps.at(-1)).toMatch(/the quote expired/)
    expect(await evm.account(fay.address).balance()).toBe(0)
    await expect(swap.refundSource(r)).rejects.toThrow(/early/)
    await anvilIncreaseTime(node.rpcUrl, 5 * 3600)
    await swap.refundSource(r)
    expect(await evm.account(fay.address).balance()).toBe(50 * USDC)
  }, 120_000)

  it('a cautious agent waits for confirmations of the USDC lock before locking sats (S10)', async () => {
    const cautious = new LiquidityAgent(lpWallet, evm, lpAccount.address, findSpend, async () => await spendable(lpWallet), { ...DEFAULT_LIQUIDITY, minSourceConfirmations: 3 })
    const swap = new DonorSwap(await chain.makeWallet(), evm, fay.address, chain.chainTracker)
    let r = await swap.requestQuote(cautious, 20 * USDC)
    r = await swap.lockAndRequest(cautious, r) // mined in the latest block: 1 confirmation
    expect(r.lock).toBeUndefined()
    expect(r.steps.at(-1)).toMatch(/wait: the USDC lock has 1 of 3 confirmations/)
    expect(cautious.state(r.quote.id)).toBe('quoted') // not refused: the quote stays open
    expect((await evm.htlc(r.sourceHtlcId!))?.confirmations).toBe(1)
    await anvilMine(node.rpcUrl, 2)
    r = await swap.requestLock(cautious, r)
    expect(r.lock?.satoshis).toBe(r.quote.sats)
    expect(cautious.state(r.quote.id)).toBe('locked')
  }, 120_000)

  it('the contract itself refuses a wrong secret, a stranger, and a second claim', async () => {
    const { secret, hashlock } = newSecret()
    const id = await evm.account(fay.address).lock({ receiver: lpAccount.address, amount: 10 * USDC, hashlock, refundAfter: (await evm.now()) + 3600 })
    await expect(evm.account(lpAccount.address).claim(id, newSecret().secret)).rejects.toThrow(/secret/)
    await expect(evm.account(stranger.address).claim(id, secret)).rejects.toThrow(/receiver/)
    await evm.account(lpAccount.address).claim(id, secret)
    await expect(evm.account(lpAccount.address).claim(id, secret)).rejects.toThrow(/state/)
  }, 120_000)
})
