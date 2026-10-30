/** Liquidity agent edge cases (AGENT_TEST_PLAN S2, S5, S6, S8, S9) on the simulated USDC ledger. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Wallet } from '@bsv/wallet-toolbox'
import { newSecret } from '../core/swap'
import { newSwapKey } from '../swap/bsv'
import { DEFAULT_LIQUIDITY, LiquidityAgent } from '../swap/liquidityAgent'
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
})
