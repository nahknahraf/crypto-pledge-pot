/** Fix 3: the chain watcher indexes spends nobody reported. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import { Transaction, Utils } from '@bsv/sdk'
import type { Wallet } from '@bsv/wallet-toolbox'
import { CryptoPledgePot } from '../client/cryptoPledgePot'
import { CryptoPledgePotApi } from '../client/cryptoPledgePotApi'
import { createCryptoPledgePotService } from '../server/app'
import { CryptoPledgePotDb } from '../server/db'
import { checkSpends, type SpendSource } from '../server/watcher'
import { createMockChain, memoryKnex, type MockChain } from './helpers/mockchain'

const T0 = Math.floor(Date.now() / 1000) - 30 * 86_400
let clock = T0
let chain: MockChain, server: Server, url: string, db: CryptoPledgePotDb
let service: ReturnType<typeof createCryptoPledgePotService>

/** An API client whose spend reports are "lost": they only land in `chainTxs`, our stand-in for the blockchain. */
const chainTxs = new Map<string, string>()
class LostReportsApi extends CryptoPledgePotApi {
  reportSpend = async (beef: string): Promise<{ txid: string, pledges: string[] }> => {
    const txid = Transaction.fromAtomicBEEF(Utils.toArray(beef, 'hex')).id('hex')
    chainTxs.set(txid, beef)
    return { txid, pledges: [] }
  }
}
const source: SpendSource = {
  spentBy: async (txid, vout) => [...chainTxs].find(([, b]) => Transaction.fromAtomicBEEF(Utils.toArray(b, 'hex')).inputs.some(i => i.sourceTXID === txid && i.sourceOutputIndex === vout))?.[0],
  beef: async (txid) => chainTxs.get(txid)!
}

beforeAll(async () => {
  chain = await createMockChain()
  db = new CryptoPledgePotDb(memoryKnex()); await db.migrate()
  service = createCryptoPledgePotService({ wallet: await chain.makeWallet(), db, chainTracker: chain.chainTracker, now: () => clock })
  await new Promise<void>(resolve => { server = service.app.listen(0, () => resolve()) })
  url = `http://127.0.0.1:${(server.address() as any).port}`
})
afterAll(async () => { await new Promise(r => server?.close(r)); await chain?.close() })

describe('chain watcher', () => {
  it('finds a release and a refund that were never reported, and indexes them', async () => {
    const [creator, alice, bob] = [await chain.makeWallet(), await chain.makeWallet(), await chain.makeWallet()]
    for (const w of [creator, alice, bob]) await chain.fund(w, 100_000)
    const lost = (w: Wallet): CryptoPledgePot => new CryptoPledgePot(w, new LostReportsApi(url, w))
    clock = T0
    const { campaignId, meta } = await lost(creator).launch({ title: 'Watcher check', description: '', goal: 5_000, deadline: T0 + 3_600, refundAfter: T0 + 7_200, milestones: [{ title: 'A', percent: 50 }, { title: 'B', percent: 50 }] })
    const pa = await lost(alice).donate(meta, 4_000)
    const pb = await lost(bob).donate(meta, 2_000)
    clock = T0 + 3_601
    await lost(creator).release(campaignId) // report lost
    const api = new CryptoPledgePotApi(url)
    expect((await api.campaign(campaignId)).milestonesReleased).toBe(0) // the index doesn't know yet

    const r1 = await checkSpends(db, service, source)
    expect(r1.recorded).toHaveLength(1) // one release tx spent both escrows: recorded once
    const view = await api.campaign(campaignId)
    expect(view).toMatchObject({ milestonesReleased: 1, released: 3_000, escrowed: 3_000 })

    clock = T0 + 7_201
    await lost(bob).refund(pb.id, 'deadline', clock) // reclaimed, report lost
    const r2 = await checkSpends(db, service, source)
    expect(r2.recorded).toHaveLength(1)
    expect((await api.pledge(pb.id)).pledge.status).toBe('refunded')
    expect((await api.pledge(pa.id)).pledge).toMatchObject({ status: 'active', stage: 1 })

    const r3 = await checkSpends(db, service, source) // nothing new: idempotent
    expect(r3).toMatchObject({ recorded: [], pending: [] })
  })
})

describe('when the spend lookup fails', () => {
  const pledges = ['a', 'b', 'c'].map(t => ({ outpoint: `${t.repeat(64)}.0` }))
  const db = { activePledges: async () => pledges } as unknown as CryptoPledgePotDb
  const service = { recordSpend: async () => { throw new Error('not reached') } }
  const failing = (fail: (txid: string) => Error | undefined): SpendSource => ({
    spentBy: async (txid) => { const e = fail(txid); if (e !== undefined) throw e; return undefined },
    beef: async () => { throw new Error('not reached') }
  })

  it('a server error on one escrow is noted, and the others are still checked', async () => {
    const r = await checkSpends(db, service as any, failing(t => t.startsWith('a') ? new Error('WhatsOnChain spent lookup HTTP 500') : undefined))
    expect(r).toMatchObject({ checked: 3, recorded: [] })
    expect(r.pending).toEqual([`${'a'.repeat(64)}.0: WhatsOnChain spent lookup HTTP 500`])
  })

  it('a rate limit (429) ends the round instead of hammering, and changes nothing', async () => {
    const r = await checkSpends(db, service as any, failing(t => t.startsWith('b') ? new Error('WhatsOnChain spent lookup HTTP 429') : undefined))
    expect(r.checked).toBe(2)
    expect(r.pending).toHaveLength(1)
    expect(r.recorded).toEqual([])
  })
})

