/**
 * Giving routines end to end, offline: real wallet-toolbox wallets on the mock
 * chain, the CryptoPledgePot server over HTTP with BRC-103 auth, and the
 * browser's own execution code (app/src/routines.ts). Shows that a run is a
 * normal escrow pledge from the donor's wallet, and that the server only
 * records runs that respect the routine's owner, target and limits.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import type { Request } from 'express'
import type { Wallet } from '@bsv/wallet-toolbox'
import { CryptoPledgePot } from '../client/cryptoPledgePot'
import { CryptoPledgePotApi } from '../client/cryptoPledgePotApi'
import { createCryptoPledgePotApp } from '../server/app'
import { CryptoPledgePotDb } from '../server/db'
import { brc103OwnerResolver } from '../server/routines'
import { keywordsFor, type Routine, type RoutineDraft } from '../core/routines'
import { executeRoutine, planRun, ServerRoutineStore } from '../app/src/routines'
import { RoutineAgent, type RoutineAgentState } from '../agent/routineAgent'
import { memoryStore } from '../agent/ledger'
import { createMockChain, memoryKnex, type MockChain } from './helpers/mockchain'

let chain: MockChain
let server: Server
let url: string
const T0 = Math.floor(Date.now() / 1000)

const as = (w: Wallet): CryptoPledgePot => new CryptoPledgePot(w, new CryptoPledgePotApi(url, w))
const apiOf = (w: Wallet): CryptoPledgePotApi => new CryptoPledgePotApi(url, w)

const monthly: RoutineDraft = {
  text: 'Spende jeden Monat 2000 sats an einen Tierschutzverein',
  amount: { value: 2_000, currency: 'SATS' },
  interval: 'monthly',
  target: { label: 'Tierschutzverein', keywords: keywordsFor('Tierschutzverein') },
  limits: { maxSatsPerRun: 3_000, maxRuns: 2, maxTotalSats: null }
}

beforeAll(async () => {
  chain = await createMockChain()
  const arbiter = await chain.makeWallet()
  const db = new CryptoPledgePotDb(memoryKnex())
  await db.migrate()
  const app = createCryptoPledgePotApp({ wallet: arbiter, db, chainTracker: chain.chainTracker })
  await new Promise<void>(resolve => { server = app.listen(0, () => resolve()) })
  url = `http://127.0.0.1:${(server.address() as any).port}`
})

afterAll(async () => {
  await new Promise(resolve => server?.close(resolve))
  await chain?.close()
})

describe('a monthly routine for an animal shelter', () => {
  let creator: Wallet, alice: Wallet, bob: Wallet
  let shelterId: string, otherId: string
  let routine: Routine

  it('setup: two campaigns, one about animals', async () => {
    ;[creator, alice, bob] = await Promise.all([1, 2, 3].map(async () => await chain.makeWallet()))
    for (const w of [creator, alice, bob]) await chain.fund(w, 100_000)
    const base = { goal: 50_000, deadline: T0 + 30 * 86_400, refundAfter: T0 + 60 * 86_400, milestones: [{ title: 'Phase 1', percent: 50 }, { title: 'Phase 2', percent: 50 }] }
    shelterId = (await as(creator).launch({ ...base, title: 'New kennels for the dog shelter', description: 'Our animal shelter needs warm kennels.' })).campaignId
    otherId = (await as(creator).launch({ ...base, title: 'Solar panels for a school', description: 'Clean power for 300 pupils.' })).campaignId
  })

  it('reading routines needs wallet authentication', async () => {
    await expect(new CryptoPledgePotApi(url).routines()).rejects.toThrow(/connect a wallet/)
    expect((await fetch(`${url}/api/routines`)).status).toBe(401)
  })

  it('the server interprets the chat message (rule parser by default)', async () => {
    const { result, interpreter } = await apiOf(alice).interpretRoutine('Spende jeden Monat 10 Euro an einen Tierschutzverein')
    expect(interpreter).toBe('rules')
    expect(result).toMatchObject({ ok: true, draft: { amount: { value: 10, currency: 'EUR' }, interval: 'monthly' } })
  })

  it('alice creates a routine; it is due at once and visible only to her', async () => {
    routine = await apiOf(alice).createRoutine(monthly)
    expect(routine).toMatchObject({ status: 'active', owner: { scheme: 'brc103' }, runs: [] })
    expect(routine.nextRunAt).toBeLessThanOrEqual(Math.floor(Date.now() / 1000))
    expect((await apiOf(alice).routines()).map(r => r.id)).toEqual([routine.id])
    expect(await apiOf(bob).routines()).toEqual([])
    await expect(apiOf(bob).setRoutineStatus(routine.id, 'paused')).rejects.toThrow(/not found/)
  })

  it('refuses drafts that break the rules', async () => {
    await expect(apiOf(alice).createRoutine({ ...monthly, limits: { ...monthly.limits, maxSatsPerRun: 10 } })).rejects.toThrow(/maxSatsPerRun/)
  })

  it('a run is an escrow pledge from alice\'s own wallet, recorded against the routine', async () => {
    const campaigns = await new CryptoPledgePotApi(url).campaigns()
    const plan = await planRun(routine, campaigns)
    expect(plan).toMatchObject({ sats: 2_000, campaign: { id: shelterId } }) // the animal campaign, not the school
    const { routine: after, txid } = await executeRoutine(new ServerRoutineStore(apiOf(alice)), as(alice), routine, plan)
    expect(txid).toMatch(/^[0-9a-f]{64}$/)
    expect(after.runs).toHaveLength(1)
    expect(after.runs[0]).toMatchObject({ campaignId: shelterId, sats: 2_000 })
    expect(after.nextRunAt).toBeGreaterThan(Math.floor(Date.now() / 1000) + 27 * 86_400) // next month
    // The money is in the campaign's escrow under alice's name; the routine only points at it.
    const detail = await new CryptoPledgePotApi(url).campaign(shelterId)
    expect(detail.raised).toBe(2_000)
    routine = after
  })

  it('the server refuses runs that are reused, early, foreign or off-target', async () => {
    const pledgeId = routine.runs[0].pledgeId
    await expect(apiOf(alice).recordRoutineRun(routine.id, pledgeId)).rejects.toThrow(/already counts/)
    const shelter = (await new CryptoPledgePotApi(url).campaign(shelterId)).meta
    const early = await as(alice).donate(shelter, 2_000)
    await expect(apiOf(alice).recordRoutineRun(routine.id, early.id)).rejects.toThrow(/not due/)
    const bobs = await as(bob).donate(shelter, 2_000)
    await expect(apiOf(alice).recordRoutineRun(routine.id, bobs.id)).rejects.toThrow(/not made by you/)
    const school = (await new CryptoPledgePotApi(url).campaign(otherId)).meta
    const offTarget = await as(alice).donate(school, 2_000)
    await expect(apiOf(alice).recordRoutineRun(routine.id, offTarget.id)).rejects.toThrow(/does not match/)
  })

  it('pause, resume and stop; a stopped routine stays stopped', async () => {
    expect((await apiOf(alice).setRoutineStatus(routine.id, 'paused')).status).toBe('paused')
    expect((await apiOf(alice).setRoutineStatus(routine.id, 'active')).status).toBe('active')
    const stopped = await apiOf(alice).setRoutineStatus(routine.id, 'cancelled')
    expect(stopped).toMatchObject({ status: 'cancelled', nextRunAt: null })
    await expect(apiOf(alice).setRoutineStatus(routine.id, 'active')).rejects.toThrow(/cannot change/)
  })
})

describe('automatic execution by the owner\'s routine agent', () => {
  let alice: Wallet, bob: Wallet, agentWallet: Wallet, poorWallet: Wallet
  let agent: RoutineAgent, poorAgent: RoutineAgent
  let agentKey: string
  let campaignId: string
  const draft: RoutineDraft = { ...monthly, text: 'Give 1500 sats every month to an animal shelter', amount: { value: 1_500, currency: 'SATS' }, limits: { maxSatsPerRun: 2_000, maxRuns: null, maxTotalSats: null } }
  const balanceOf = (w: Wallet) => async () => (await w.listOutputs({ basket: 'default', limit: 1000 })).outputs.filter(o => o.spendable).reduce((s, o) => s + o.satoshis, 0)
  const makeAgent = (w: Wallet): RoutineAgent => new RoutineAgent({
    api: apiOf(w), client: as(w), balance: balanceOf(w), state: memoryStore<RoutineAgentState>({ ownerIdentityKey: null, activity: [] })
  })

  it('setup: an animal campaign, the owner, a stranger, and an agent with its own funded wallet', async () => {
    ;[alice, bob, agentWallet, poorWallet] = await Promise.all([1, 2, 3, 4].map(async () => await chain.makeWallet()))
    for (const w of [alice, bob, agentWallet]) await chain.fund(w, 50_000)
    const creator = await chain.makeWallet()
    await chain.fund(creator, 20_000)
    campaignId = (await as(creator).launch({
      title: 'Food for the cat sanctuary', description: 'An animal shelter for 40 cats.', goal: 100_000,
      deadline: T0 + 30 * 86_400, refundAfter: T0 + 60 * 86_400, milestones: [{ title: 'Food', percent: 100 }]
    })).campaignId
    agent = makeAgent(agentWallet)
    poorAgent = makeAgent(poorWallet)
    agentKey = (await agentWallet.getPublicKey({ identityKey: true })).publicKey
    // In the app the first BRC-29 top-up sets the owner; here we set it directly.
    agent.claimOwner(alice.identityKey)
    poorAgent.claimOwner(alice.identityKey)
    expect(() => agent.claimOwner(bob.identityKey)).toThrow(/another identity/)
  })

  it('without a delegation the agent runs nothing', async () => {
    await apiOf(alice).createRoutine(draft)
    expect(await agent.step()).toMatchObject({ delegated: 0, paid: 0 })
  })

  it('only the owner can delegate, and not to their own identity', async () => {
    const r = await apiOf(alice).createRoutine(draft)
    await expect(apiOf(bob).setRoutineExecutor(r.id, agentKey)).rejects.toThrow(/not found/)
    await expect(apiOf(alice).setRoutineExecutor(r.id, alice.identityKey)).rejects.toThrow(/your own identity/)
    await expect(apiOf(alice).setRoutineExecutor(r.id, 'not-a-key')).rejects.toThrow(/compressed public key/)
  })

  it('once delegated, the agent pledges from ITS wallet without asking alice, and the run is recorded', async () => {
    // Pinned to the sanctuary: the dog-shelter campaign from the block above matches "animal" too.
    const r = await apiOf(alice).createRoutine({ ...draft, target: { ...draft.target, campaignId } })
    expect((await apiOf(alice).setRoutineExecutor(r.id, agentKey)).executor).toMatchObject({ identityKey: agentKey })
    const aliceBefore = await balanceOf(alice)()
    const summary = await agent.step()
    expect(summary).toMatchObject({ delegated: 1, due: 1, paid: 1, sats: 1_500 })
    const [after] = (await apiOf(alice).routines()).filter(x => x.id === r.id)
    expect(after.runs).toHaveLength(1)
    expect(after.runs[0]).toMatchObject({ campaignId, sats: 1_500 })
    expect(await balanceOf(alice)()).toBe(aliceBefore) // alice's wallet was not touched
    // The escrow pledge belongs to the agent's wallet (it paid), not to alice.
    const { pledge } = await new CryptoPledgePotApi(url).pledge(after.runs[0].pledgeId)
    expect(pledge).toMatchObject({ amount: 1_500, donorIdentity: agentKey, message: 'Giving routine: Tierschutzverein' })
    expect(agent.state.activity.at(-1)).toMatchObject({ kind: 'paid', sats: 1_500, routineId: r.id })
    // Not due again until next month.
    expect(await agent.step()).toMatchObject({ due: 0, paid: 0 })
  })

  it('revoking takes effect at once: the server refuses the agent\'s next run', async () => {
    const r = await apiOf(alice).createRoutine(draft)
    await apiOf(alice).setRoutineExecutor(r.id, agentKey)
    await apiOf(alice).setRoutineExecutor(r.id, null)
    expect((await apiOf(agentWallet).delegatedRoutines()).map(x => x.id)).not.toContain(r.id)
    const meta = (await new CryptoPledgePotApi(url).campaign(campaignId)).meta
    const pledge = await as(agentWallet).donate(meta, 1_500)
    await expect(apiOf(agentWallet).recordRoutineRun(r.id, pledge.id)).rejects.toThrow(/not found/)
  })

  it('the agent ignores routines of anyone but its owner, and waits when its budget is too low', async () => {
    const strangers = await apiOf(bob).createRoutine(draft)
    await apiOf(bob).setRoutineExecutor(strangers.id, agentKey)
    expect(await agent.step()).toMatchObject({ paid: 0 })
    expect((await apiOf(bob).routines())[0].runs).toHaveLength(0)

    const r = await apiOf(alice).createRoutine(draft)
    const poorKey = (await poorWallet.getPublicKey({ identityKey: true })).publicKey
    await apiOf(alice).setRoutineExecutor(r.id, poorKey)
    expect(await poorAgent.step()).toMatchObject({ due: 1, paid: 0, skipped: 1 })
    expect(poorAgent.state.activity.at(-1)?.text).toMatch(/budget too low/)
  })
})

it('a request carrying x-zk-proof is refused (501) until ZK auth is supported, not treated as BRC-103', () => {
  const resolve = brc103OwnerResolver(() => '02'.padEnd(66, 'b'))
  const req = (headers: Record<string, string>) => ({ get: (h: string) => headers[h.toLowerCase()] }) as unknown as Request
  expect(resolve(req({}))).toEqual({ scheme: 'brc103', identityKey: '02'.padEnd(66, 'b') })
  expect(() => resolve(req({ 'x-zk-proof': 'proof' }))).toThrow(expect.objectContaining({ status: 501 }))
})
