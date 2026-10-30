/**
 * Cross-chain swap, end to end. BSV side: real wallets on the mock chain, the
 * sCrypt AtomicSwap validated by the chain. Other side: the simulated USDC
 * HTLC ledger. Nobody can take anyone's funds in any of these scenarios.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import { Transaction } from '@bsv/sdk'
import type { Wallet } from '@bsv/wallet-toolbox'
import { CryptoPledgePot } from '../client/cryptoPledgePot'
import { CryptoPledgePotApi } from '../client/cryptoPledgePotApi'
import { createCryptoPledgePotApp } from '../server/app'
import { CryptoPledgePotDb } from '../server/db'
import { lockSats, newSwapKey, type SpendFinder } from '../swap/bsv'
import { DonorSwap } from '../swap/donorSwap'
import { DEFAULT_LIQUIDITY, LiquidityAgent } from '../swap/liquidityAgent'
import { SimulatedUsdcChain, USDC } from '../swap/usdcChain'
import { createMockChain, memoryKnex, type MockChain } from './helpers/mockchain'

const T0 = Math.floor(Date.now() / 1000) - 30 * 86_400
let clock = T0
let chain: MockChain, usdc: SimulatedUsdcChain, server: Server, url: string
let lpWallet: Wallet, lp: LiquidityAgent
const H = 3600

const spendable = async (w: Wallet): Promise<number> => (await w.listOutputs({ basket: 'default', limit: 1000 })).outputs.filter(o => o.spendable).reduce((s, o) => s + o.satoshis, 0)
const findSpend: SpendFinder = async (txid, vout) => {
  const storage = (chain.services as any).storage
  const row = await storage.knex('mockchain_utxos').where({ txid, vout }).first()
  if (row?.spentByTxid == null) return undefined
  return Transaction.fromBinary(Array.from((await storage.getTransaction(row.spentByTxid)).rawTx as number[]))
}
const donor = async (name: string, usdcAmount: number, sats = 0): Promise<{ wallet: Wallet, swap: DonorSwap, address: string }> => {
  const wallet = await chain.makeWallet()
  if (sats > 0) await chain.fund(wallet, sats)
  usdc.mint(`0x${name}`, usdcAmount)
  return { wallet, swap: new DonorSwap(wallet, usdc, `0x${name}`, chain.chainTracker), address: `0x${name}` }
}

beforeAll(async () => {
  chain = await createMockChain()
  usdc = new SimulatedUsdcChain(() => clock)
  lpWallet = await chain.makeWallet()
  await chain.fund(lpWallet, 10_000_000)
  lp = new LiquidityAgent(lpWallet, usdc, '0xLiquidityAgent', findSpend, async () => await spendable(lpWallet))
  const db = new CryptoPledgePotDb(memoryKnex()); await db.migrate()
  const arbiter = await chain.makeWallet()
  await new Promise<void>(resolve => { server = createCryptoPledgePotApp({ wallet: arbiter, db, chainTracker: chain.chainTracker, now: () => clock }).listen(0, () => resolve()) })
  url = `http://127.0.0.1:${(server.address() as any).port}`
}, 120_000)
afterAll(async () => { await new Promise(r => server?.close(r)); await chain?.close() })

describe('happy path: USDC on another chain → sats in the donor\'s own wallet → a pledge', () => {
  it('a donor with ZERO sats and 100 USDC ends up with sats, and the LP with the USDC', async () => {
    clock = T0
    const d = await donor('Fay', 100 * USDC)
    expect(await spendable(d.wallet)).toBe(0)
    const lpSatsBefore = await spendable(lpWallet)

    let r = await d.swap.requestQuote(lp, 100 * USDC)
    expect(r.quote.sats).toBe(2_150_000)
    r = await d.swap.lockAndRequest(lp, r)
    expect(r.lock).toBeDefined()
    expect(await d.swap.verifyLock(r)).toEqual([])
    expect(await usdc.account(d.address).balance()).toBe(0) // locked, not given away

    r = await d.swap.claim(r)
    expect(r.state).toBe('claimed')
    const got = await spendable(d.wallet)
    expect(got).toBeGreaterThan(2_150_000 - 2_000) // the quoted sats minus the claim fee
    expect(got).toBeLessThanOrEqual(2_150_000)

    await lp.step() // the LP reads the secret from the BSV claim and collects the USDC
    expect(lp.state(r.quote.id)).toBe('settled')
    expect(await usdc.account('0xLiquidityAgent').balance()).toBe(100 * USDC)
    expect((await usdc.htlc(r.sourceHtlcId!))?.secret).toBe(r.secret)
    expect(lpSatsBefore - (await spendable(lpWallet))).toBeGreaterThanOrEqual(2_150_000)
    expect(lp.log.join(' | ')).toMatch(/read the secret from BSV and collected 100.00 USDC/)

    // And the point of it all: the swapped sats back a campaign.
    const creator = await chain.makeWallet(); await chain.fund(creator, 50_000)
    const { meta } = await new CryptoPledgePot(creator, new CryptoPledgePotApi(url, creator)).launch({
      title: 'Clean water for Kitui', description: 'One well, published water tests.', goal: 1_000_000, deadline: clock + 7 * 86_400, refundAfter: clock + 40 * 86_400,
      milestones: [{ title: 'Drill', percent: 60 }, { title: 'Publish tests', percent: 40 }]
    })
    const pledge = await new CryptoPledgePot(d.wallet, new CryptoPledgePotApi(url, d.wallet)).donate(meta, 1_000_000, { name: 'Fay', message: 'Came over from USDC' })
    expect(pledge).toMatchObject({ amount: 1_000_000, status: 'active' })
  })
})

describe('when things go wrong, everyone gets their own money back', () => {
  it('the LP refuses (expired quote): the donor refunds the USDC after T1, not before', async () => {
    clock = T0 + 10 * H
    const d = await donor('Gus', 50 * USDC)
    let r = await d.swap.requestQuote(lp, 50 * USDC)
    clock += DEFAULT_LIQUIDITY.quoteValidity + 1
    r = await d.swap.lockAndRequest(lp, r)
    expect(r.lock).toBeUndefined()
    expect(r.steps.at(-1)).toMatch(/did not lock sats: the quote expired/)
    await expect(d.swap.refundSource(r)).rejects.toThrow(/refund time not reached/)
    clock += 5 * H
    await d.swap.refundSource(r)
    expect(await usdc.account(d.address).balance()).toBe(50 * USDC)
  })

  it('the donor never claims: the LP refunds its sats after T2, the donor refunds the USDC after T1, the LP never gets the USDC', async () => {
    clock = T0 + 30 * H
    const d = await donor('Hal', 20 * USDC)
    let r = await d.swap.requestQuote(lp, 20 * USDC)
    r = await d.swap.lockAndRequest(lp, r)
    const lpBefore = await spendable(lpWallet)
    await lp.step()
    expect(lp.state(r.quote.id)).toBe('locked') // T2 not reached: nothing happens
    clock = r.lock!.terms.refundAfter
    await lp.step()
    expect(lp.state(r.quote.id)).toBe('refunded')
    expect(await spendable(lpWallet)).toBeGreaterThan(lpBefore + r.quote.sats - 3_000)
    clock = (await usdc.htlc(r.sourceHtlcId!))!.refundAfter
    await d.swap.refundSource(r)
    expect(await usdc.account(d.address).balance()).toBe(20 * USDC)
    expect((await usdc.htlc(r.sourceHtlcId!))?.secret).toBeUndefined() // the secret never left the donor
  })

  it('a cheating LP locks fewer sats or pays someone else: the donor refuses to claim, then refunds', async () => {
    clock = T0 + 60 * H
    const d = await donor('Ivy', 40 * USDC)
    const evil = await chain.makeWallet(); await chain.fund(evil, 1_000_000)
    for (const cheat of ['short', 'wrong-key'] as const) {
      let r = await d.swap.requestQuote(lp, 10 * USDC)
      r = await d.swap.lockAndRequest(lp, r)
      const k = await newSwapKey(evil)
      const other = await newSwapKey(evil)
      const receiver = cheat === 'wrong-key' ? other.publicKey : r.lock!.terms.receiver
      const sats = cheat === 'short' ? r.quote.sats - 100_000 : r.quote.sats
      r.lock = await lockSats(evil, { ...r.lock!.terms, receiver, sender: k.publicKey }, sats, k.keyID) // pretend this came from the LP
      r = await d.swap.claim(r)
      expect(r.state).toBe('refused')
      expect(r.steps.at(-1)).toMatch(cheat === 'short' ? /less than the quoted/ : /does not pay your key/)
    }
  })

  it('the LP refuses unsafe or oversized swaps', async () => {
    clock = T0 + 90 * H
    const d = await donor('Jo', 1_000 * USDC)
    await expect(d.swap.requestQuote(lp, 600 * USDC)).rejects.toThrow(/above this agent's limit/)
    const r = await d.swap.requestQuote(lp, 10 * USDC)
    const id = await usdc.account(d.address).lock({ receiver: '0xLiquidityAgent', amount: 10 * USDC, hashlock: r.hashlock, refundAfter: clock + H }) // only 1 h
    await expect(lp.acceptSourceLock(r.quote.id, id)).rejects.toThrow(/timeout is too short/)
    const poor = new LiquidityAgent(lpWallet, usdc, '0xPoorLP', findSpend, async () => 10_000)
    await expect(poor.quote(10 * USDC, r.quote.donorBsvKey)).rejects.toThrow(/not enough BSV inventory/)
  })
})
