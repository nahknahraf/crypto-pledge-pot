/**
 * Model-based fuzzing of HashedTimelockERC20 on Anvil: random locks, claims (right or wrong secret,
 * right or wrong caller), refunds and clock jumps. Every call's success must match a simple model of
 * the rules, and tokens are conserved: the HTLC holds exactly the sum of open locks, and the users
 * hold the rest. A seeded PRNG makes failures reproducible (FUZZ_SEED, FUZZ_STEPS; FUZZ_REPORT=<file> appends what was exercised).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createPublicClient, createWalletClient, http, type Address, type Hex } from 'viem'
import { anvil as anvilChain } from 'viem/chains'
import { Hash, Utils } from '@bsv/sdk'
import { anvilAccount, anvilBinary, anvilIncreaseTime, startAnvil, type Anvil } from '../swap/anvil'
import { deployBridgeContracts, HTLC_ABI, mintTestUsdc, TOKEN_ABI } from '../swap/evmChain'

const SEED = Number(process.env.FUZZ_SEED ?? 20261031)
const STEPS = Number(process.env.FUZZ_STEPS ?? 150)
const users = [1, 2, 3].map(i => anvilAccount(i))
const MINT = 1_000_000n
let node: Anvil, htlc: Address, usdc: Address

/** mulberry32: small, seeded, good enough to explore. */
const prng = (seed: number) => () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296 }

interface ModelLock { id: Hex, sender: number, receiver: number, amount: bigint, secret: Hex, refundAfter: number, state: 'locked' | 'claimed' | 'refunded' }

describe.skipIf(anvilBinary() === undefined)('HashedTimelockERC20 under random operations (model-based fuzz)', () => {
  const pub = () => createPublicClient({ chain: anvilChain, transport: http(node.rpcUrl) })
  const as = (u: number) => createWalletClient({ chain: anvilChain, transport: http(node.rpcUrl), account: users[u] })
  const now = async (): Promise<number> => Number((await pub().getBlock({ blockTag: 'latest' })).timestamp)
  const bal = async (a: Address): Promise<bigint> => await pub().readContract({ address: usdc, abi: TOKEN_ABI, functionName: 'balanceOf', args: [a] }) as bigint
  const send = async (u: number, functionName: string, args: unknown[]): Promise<{ ok: boolean, result?: unknown }> => {
    try {
      const { request, result } = await pub().simulateContract({ address: htlc, abi: HTLC_ABI, functionName, args, account: users[u] } as any)
      await pub().waitForTransactionReceipt({ hash: await as(u).writeContract(request as any) })
      return { ok: true, result }
    } catch { return { ok: false } }
  }

  beforeAll(async () => {
    node = await startAnvil()
    ;({ htlc, token: usdc } = await deployBridgeContracts(node.rpcUrl, anvilChain, anvilAccount(0), { withTestToken: true }) as { htlc: Address, token: Address })
    for (let u = 0; u < users.length; u++) {
      await mintTestUsdc(node.rpcUrl, anvilChain, anvilAccount(0), usdc, users[u].address, Number(MINT))
      await pub().waitForTransactionReceipt({ hash: await as(u).writeContract({ address: usdc, abi: TOKEN_ABI, functionName: 'approve', args: [htlc, 10n ** 18n] }) })
    }
  }, 60_000)
  afterAll(async () => { await node?.stop() })

  it(`${STEPS} random steps (seed ${SEED}): every outcome matches the model; tokens are conserved`, async () => {
    const rnd = prng(SEED); const pick = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)]
    const locks: ModelLock[] = []
    const tally = { lock: 0, claim: 0, refund: 0, refused: 0, warp: 0, skipped: 0 }
    for (let step = 0; step < STEPS; step++) {
      const t = await now()
      // The next block's timestamp is t+1 or a little later: skip calls whose outcome sits on a timeout boundary.
      const nearBoundary = (l: ModelLock): boolean => Math.abs(l.refundAfter - (t + 1)) <= 3
      const r = rnd()
      if (r < 0.35 || locks.length === 0) {
        const sender = Math.floor(rnd() * 3); const receiver = Math.floor(rnd() * 3)
        const amount = BigInt(1 + Math.floor(rnd() * 5_000))
        const secret = `0x${Utils.toHex(Array.from({ length: 32 }, () => Math.floor(rnd() * 256)))}` as Hex
        const hashlock = `0x${Utils.toHex(Hash.sha256(Utils.toArray(secret.slice(2), 'hex')))}` as Hex
        const refundAfter = t + (rnd() < 0.1 ? -5 : 30 + Math.floor(rnd() * 600)) // sometimes already past
        const expectOk = refundAfter > t + 3 && amount <= await bal(users[sender].address)
        if (Math.abs(refundAfter - (t + 1)) <= 3) { tally.skipped++; continue }
        const res = await send(sender, 'lock', [users[receiver].address, usdc, amount, hashlock, BigInt(refundAfter)])
        expect(res.ok, `step ${step}: lock (expected ${expectOk ? 'ok' : 'refusal'})`).toBe(expectOk)
        if (res.ok) { locks.push({ id: res.result as Hex, sender, receiver, amount, secret, refundAfter, state: 'locked' }); tally.lock++ } else tally.refused++
      } else if (r < 0.65) {
        const l = pick(locks); if (nearBoundary(l)) { tally.skipped++; continue }
        const caller = rnd() < 0.7 ? l.receiver : Math.floor(rnd() * 3)
        const right = rnd() < 0.8
        const expectOk = l.state === 'locked' && caller === l.receiver && right && t + 1 < l.refundAfter
        const res = await send(caller, 'claim', [l.id, right ? l.secret : `0x${'00'.repeat(32)}`])
        expect(res.ok, `step ${step}: claim (expected ${expectOk ? 'ok' : 'refusal'})`).toBe(expectOk)
        if (res.ok) { l.state = 'claimed'; tally.claim++ } else tally.refused++
      } else if (r < 0.9) {
        const l = pick(locks); if (nearBoundary(l)) { tally.skipped++; continue }
        const caller = rnd() < 0.7 ? l.sender : Math.floor(rnd() * 3)
        const expectOk = l.state === 'locked' && caller === l.sender && t + 1 >= l.refundAfter
        const res = await send(caller, 'refund', [l.id])
        expect(res.ok, `step ${step}: refund (expected ${expectOk ? 'ok' : 'refusal'})`).toBe(expectOk)
        if (res.ok) { l.state = 'refunded'; tally.refund++ } else tally.refused++
      } else {
        await anvilIncreaseTime(node.rpcUrl, 30 + Math.floor(rnd() * 400)); tally.warp++
      }
      // Invariants after every step.
      const open = locks.filter(l => l.state === 'locked').reduce((s, l) => s + l.amount, 0n)
      expect(await bal(htlc), `step ${step}: HTLC balance = open locks`).toBe(open)
      const held = (await Promise.all(users.map(async u => await bal(u.address)))).reduce((a, b) => a + b, 0n)
      expect(held + open, `step ${step}: conservation`).toBe(MINT * 3n)
    }
    // The chain's own record agrees with the model for every lock.
    for (const l of locks) {
      const onChain = await pub().readContract({ address: htlc, abi: HTLC_ABI, functionName: 'locks', args: [l.id] }) as readonly unknown[]
      expect(Number(onChain[6])).toBe({ locked: 1, claimed: 2, refunded: 3 }[l.state])
      if (l.state === 'claimed') expect(onChain[8]).toBe(l.secret)
    }
    if (process.env.FUZZ_REPORT !== undefined) (await import('node:fs')).appendFileSync(process.env.FUZZ_REPORT, `seed ${SEED}: ${JSON.stringify(tally)}\n`)
    expect(tally.claim).toBeGreaterThan(0); expect(tally.refund).toBeGreaterThan(0); expect(tally.refused).toBeGreaterThan(0)
  }, 300_000)
})
