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

it('a request carrying x-zk-proof is refused (501) until ZK auth is supported, not treated as BRC-103', () => {
  const resolve = brc103OwnerResolver(() => '02'.padEnd(66, 'b'))
  const req = (headers: Record<string, string>) => ({ get: (h: string) => headers[h.toLowerCase()] }) as unknown as Request
  expect(resolve(req({}))).toEqual({ scheme: 'brc103', identityKey: '02'.padEnd(66, 'b') })
  expect(() => resolve(req({ 'x-zk-proof': 'proof' }))).toThrow(expect.objectContaining({ status: 501 }))
})
