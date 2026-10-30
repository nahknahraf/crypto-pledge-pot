/** Liquidity agent edge cases (AGENT_TEST_PLAN S2, S5, S6, S8, S9) on the simulated USDC ledger. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Wallet } from '@bsv/wallet-toolbox'
import { newSecret } from '../core/swap'
import { newSwapKey } from '../swap/bsv'
import { memoryStore, type Store } from '../agent/ledger'
import { DEFAULT_LIQUIDITY, LiquidityAgent, type LpSwap } from '../swap/liquidityAgent'
import { SimulatedUsdcChain, USDC, type SourceChain } from '../swap/usdcChain'
import { createMockChain, type MockChain } from './helpers/mockchain'

const T0 = Math.floor(Date.now() / 1000) - 30 * 86_400
let clock = T0
let chain: MockChain, usdc: SimulatedUsdcChain, lpWallet: Wallet, lp: LiquidityAgent, donorKey: string
const spendable = async (w: Wallet): Promise<number> => (await w.listOutputs({ basket: 'default', limit: 1000 })).outputs.filter(o => o.spendable).reduce((s, o) => s + o.satoshis, 0)
const lockFor = async (amount: number, refundAfter: number): Promise<string> =>
  await usdc.account('0xDonor').lock({ receiver: '0xLP', amount, hashlock: newSecret().hashlock, refundAfter })

beforeAll(async () => {
  chain = await createMockChain()
  usdc = new SimulatedUsdcChain(() => clock)
  usdc.mint('0xDonor', 10_000 * USDC)
  lpWallet = await chain.makeWallet(); await chain.fund(lpWallet, 3_000_000)
  lp = new LiquidityAgent(lpWallet, usdc, '0xLP', async () => undefined, async () => await spendable(lpWallet))
  donorKey = (await newSwapKey(await chain.makeWallet())).publicKey
}, 120_000)
afterAll(async () => { await chain?.close() })

describe('quotes', () => {
  it('refuses 0, negative, fractional micro-USDC, and one unit above the limit', async () => {
    for (const a of [0, -1, 1.5, DEFAULT_LIQUIDITY.maxUsdc + 1]) await expect(lp.quote(a, donorKey), String(a)).rejects.toThrow()
  })
  it('refuses a donor key that is not a compressed public key', async () => {
    for (const k of ['', '04' + 'ab'.repeat(32), donorKey.slice(0, 64), donorKey.toUpperCase()]) await expect(lp.quote(USDC, k)).rejects.toThrow(/compressed public key/)
  })
  it('counts open quotes against inventory: the quote that would overdraw it is refused', async () => {
    // 3,000,000 sats of inventory, 5,000 fee reserve: 100 USDC (2,150,000) fits once, not twice.
    await lp.quote(100 * USDC, donorKey)
    await expect(lp.quote(100 * USDC, donorKey)).rejects.toThrow(/inventory/)
  })
})

describe('accepting a source lock', () => {
  it('accepts a timeout exactly at the minimum, refuses one second less', async () => {
    clock = T0 + 86_400
    const fresh = new LiquidityAgent(lpWallet, usdc, '0xLP', async () => undefined, async () => await spendable(lpWallet))
    const q1 = await fresh.quote(10 * USDC, donorKey)
    await expect(fresh.acceptSourceLock(q1.id, await lockFor(10 * USDC, q1.minSourceRefundAfter - 1))).rejects.toThrow(/too short/)
    const q2 = await fresh.quote(10 * USDC, donorKey)
    expect((await fresh.acceptSourceLock(q2.id, await lockFor(10 * USDC, q2.minSourceRefundAfter))).satoshis).toBe(q2.sats)
  })
  it('never locks sats twice for the same USDC lock (two quotes, one lock)', async () => {
    clock = T0 + 2 * 86_400
    const fresh = new LiquidityAgent(lpWallet, usdc, '0xLP', async () => undefined, async () => await spendable(lpWallet))
    const a = await fresh.quote(5 * USDC, donorKey)
    const b = await fresh.quote(5 * USDC, donorKey)
    const id = await lockFor(5 * USDC, a.minSourceRefundAfter)
    await fresh.acceptSourceLock(a.id, id)
    await expect(fresh.acceptSourceLock(b.id, id)).rejects.toThrow(/already used/)
    expect(fresh.state(b.id)).toBe('rejected')
  })
  it('...also when both requests are in flight at once', async () => {
    clock = T0 + 3 * 86_400
    // Hold the first request inside its chain lookup while the second runs to completion.
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let calls = 0
    const gated: SourceChain = { name: usdc.name, now: async () => await usdc.now(), account: a => usdc.account(a), htlc: async id => { if (calls++ === 0) await gate; return await usdc.htlc(id) } }
    const fresh = new LiquidityAgent(lpWallet, gated, '0xLP', async () => undefined, async () => await spendable(lpWallet))
    const a = await fresh.quote(5 * USDC, donorKey)
    const b = await fresh.quote(5 * USDC, donorKey)
    const id = await lockFor(5 * USDC, a.minSourceRefundAfter)
    const first = fresh.acceptSourceLock(a.id, id)
    const second = await Promise.allSettled([fresh.acceptSourceLock(b.id, id)])
    release()
    const results = [await Promise.allSettled([first]), second].flat()
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
  })

  it('a crash right after broadcasting the BSV lock: the restarted agent finds the lock in its basket, then refunds it on time', async () => {
    clock = T0 + 4 * 86_400
    const disk = memoryStore<LpSwap[]>([])
    // Simulate dying between the broadcast and saving 'locked': that save never reaches the disk.
    const crashing: Store<LpSwap[]> = { load: disk.load, save: v => { if (v.some(x => x.state === 'locked')) throw new Error('process died'); disk.save(v) } }
    const before = new LiquidityAgent(lpWallet, usdc, '0xLP', async () => undefined, async () => await spendable(lpWallet), DEFAULT_LIQUIDITY, crashing)
    const q = await before.quote(5 * USDC, donorKey)
    await expect(before.acceptSourceLock(q.id, await lockFor(5 * USDC, q.minSourceRefundAfter))).rejects.toThrow(/process died/)
    expect(disk.load().map(x => x.state)).toEqual(['locking'])
    const inventory = await spendable(lpWallet)

    const after = new LiquidityAgent(lpWallet, usdc, '0xLP', async () => undefined, async () => await spendable(lpWallet), DEFAULT_LIQUIDITY, disk)
    await after.step() // finds the broadcast lock
    const swap = after.all().find(x => x.quote.id === q.id)!
    expect(swap.state).toBe('locked')
    expect(swap.lock?.satoshis).toBe(q.sats)
    expect(after.log.join(' ')).toMatch(/recovered our lock/)

    clock = swap.lock!.terms.refundAfter // the donor never claims
    await after.step()
    expect(after.state(q.id)).toBe('refunded')
    expect(await spendable(lpWallet)).toBeGreaterThan(inventory + q.sats - 2_000) // the sats came back
  })

  it('a crash before anything was broadcast: the restarted agent closes the swap instead of guessing', async () => {
    clock = T0 + 5 * 86_400
    const disk = memoryStore<LpSwap[]>([])
    const a = new LiquidityAgent(lpWallet, usdc, '0xLP', async () => undefined, async () => await spendable(lpWallet), DEFAULT_LIQUIDITY, disk)
    const q = await a.quote(5 * USDC, donorKey)
    const pending = { terms: { hashlock: newSecret().hashlock, receiver: donorKey, sender: donorKey, refundAfter: clock + 3600 }, satoshis: q.sats }
    disk.save(disk.load().map(x => ({ ...x, state: 'locking' as const, senderKeyID: 'k', pending })))
    const b = new LiquidityAgent(lpWallet, usdc, '0xLP', async () => undefined, async () => await spendable(lpWallet), DEFAULT_LIQUIDITY, disk)
    await b.step()
    expect(b.all()[0]).toMatchObject({ state: 'rejected', note: /never broadcast/ })
  })
})

