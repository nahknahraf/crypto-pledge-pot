/** Judge-facing guarantees of the fundraising agent: anchored reports, audited limits, restart safety. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Transaction } from '@bsv/sdk'
import { CryptoPledgePotApi } from '../client/cryptoPledgePotApi'
import { parseCryptoPledgePotRecord, reportMatchesRecord, splitAnchoredReport } from '../core/campaign'
import { memoryStore } from '../shared/store'
import { MockDonorBrain } from '../donor-agent/brain'
import { checkAgent, checkReportAnchor } from '../donor-agent/diligence'
import { DonorAgent } from '../donor-agent/donorAgent'
import { parseMandate } from '../donor-agent/mandate'
import { MemoBook, type Memo } from '../donor-agent/memo'
import { runAgentDemo, type AgentDemo } from '../server/agentDemo'

let demo: AgentDemo
beforeAll(async () => { demo = await runAgentDemo({ port: 0, dataPort: 0, agentPort: 0, paceMs: 0, log: () => {} }); await demo.done }, 300_000)
afterAll(async () => { await demo?.close() })

const anchorTx = async (txid: string): Promise<Transaction> => {
  const storage = (demo.chain.services as any).storage
  return Transaction.fromBinary(Array.from((await storage.getTransaction(txid)).rawTx as number[]))
}

describe('the fundraising agent\'s reports are anchored on chain', () => {
  it('every milestone report links an on-chain record whose hash matches the posted text; a tampered report fails', async () => {
    const c = await new CryptoPledgePotApi(demo.url).campaign(demo.status().campaignId!)
    const updates = c.milestones.filter(m => m.update !== undefined)
    expect(updates.length).toBe(2) // reports for milestones 2 and 3
    for (const m of updates) {
      const { anchorTxid } = splitAnchoredReport(m.update!.note)
      expect(anchorTxid).toMatch(/^[0-9a-f]{64}$/)
      const record = (await anchorTx(anchorTxid!)).outputs.map(o => parseCryptoPledgePotRecord(o.lockingScript)).find(r => r?.kind === 'report')
      expect(reportMatchesRecord(m.update!.note, record, c.id, m.index)).toBe(true)
      expect(reportMatchesRecord(m.update!.note.replace('readings', 'READINGS'), record, c.id, m.index)).toBe(false)
      expect(reportMatchesRecord(m.update!.note, record, c.id, m.index + 1)).toBe(false)
    }
  })
})

describe('the fundraising agent publishes its limits, and its ledger is audited against them', () => {
  it('the published limits are in the anchored terms, and the real ledger passes the donor agent\'s audit', async () => {
    const c = await new CryptoPledgePotApi(demo.url).campaign(demo.status().campaignId!)
    expect(c.meta.agentLimits).toEqual({ pricePerCallSats: 50, maxSpendPerMilestoneSats: 250 })
    const check = await checkAgent(c, { api: new CryptoPledgePotApi(demo.url), chainTracker: undefined as never, txExists: async () => true })
    expect(check).toMatchObject({ ok: true, detail: expect.stringMatching(/13 receipted payment\(s\), all within its published limits/) })
  })
  it('flags payments above the cap, overspent milestones, and agents that publish no limits', async () => {
    const c = await new CryptoPledgePotApi(demo.url).campaign(demo.status().campaignId!)
    const fakeLedger = (ledger: unknown[]): typeof fetch => (async (u: string) => new Response(JSON.stringify(String(u).endsWith('/ledger') ? ledger : {}), { status: 200 })) as unknown as typeof fetch
    const tx = 'ab'.repeat(32)
    const deps = (ledger: unknown[]) => ({ api: new CryptoPledgePotApi(demo.url), chainTracker: undefined as never, txExists: async () => true, fetchImpl: fakeLedger(ledger) })
    expect((await checkAgent(c, deps([{ sats: 500, txid: tx, milestone: 2 }])))!.detail).toMatch(/above its published cap of 50/)
    expect((await checkAgent(c, deps(Array.from({ length: 6 }, () => ({ sats: 50, txid: tx, milestone: 2 })))))!.detail).toMatch(/published 250-sat limit in milestone 2/)
    expect((await checkAgent({ ...c, meta: { ...c.meta, agentLimits: undefined } }, deps([])))!.detail).toMatch(/publishes no spending limits/)
  })
})

describe('the donor agent checks a report against its anchor before voting (D11)', () => {
  /** The anchor with its merkle proof, as WhatsOnChain would serve it once mined. */
  const provenTx = async (txid: string): Promise<Transaction> => {
    let proof = await (demo.chain.services as any).getMerklePath(txid)
    if (proof.merklePath === undefined) { await demo.chain.mineBlock(); proof = await (demo.chain.services as any).getMerklePath(txid) }
    const tx = await anchorTx(txid)
    tx.merklePath = proof.merklePath
    return tx
  }
  const deps = () => ({ api: new CryptoPledgePotApi(demo.url), chainTracker: demo.chain.chainTracker, txExists: async () => true, fetchTx: provenTx })

  it('a matching report passes; an edited one is a mismatch; an unfetchable anchor is unverifiable; no anchor, no check', async () => {
    const c = await new CryptoPledgePotApi(demo.url).campaign(demo.status().campaignId!)
    const m = c.milestones.find(x => x.update !== undefined)!
    const note = m.update!.note
    expect(await checkReportAnchor(c, m.index, note, deps())).toMatchObject({ ok: true, outcome: 'match' })
    expect(await checkReportAnchor(c, m.index, note.replace('readings', 'READINGS'), deps())).toMatchObject({ ok: false, outcome: 'mismatch' })
    expect(await checkReportAnchor(c, m.index, note, { ...deps(), fetchTx: undefined })).toMatchObject({ outcome: 'unverifiable' })
    expect(await checkReportAnchor(c, m.index, 'Done, no anchor.', deps())).toBeUndefined()
  })

  it('end to end: the agent votes NO on a report edited after anchoring, and YES on the anchored original', async () => {
    const real = new CryptoPledgePotApi(demo.url)
    const id = demo.status().campaignId!
    const original = await real.campaign(id)
    const m = original.milestones.find(x => x.update !== undefined)!
    // The campaign as an index would show it before the vote: milestone m not released yet.
    const view = (edited: boolean) => ({
      ...original,
      milestones: original.milestones.map(x => x.index === m.index ? { ...x, released: false, update: { ...x.update!, note: edited ? x.update!.note.replace('readings', 'READINGS') : x.update!.note } } : { ...x, update: undefined })
    })
    for (const edited of [true, false]) {
      const votes: boolean[] = []
      const memos = new MemoBook(memoryStore<Memo[]>([]))
      memos.add({ campaignId: id, campaignTitle: 'AirWatch', kind: 'pledge', status: 'executed', summary: 'pledged', checks: [], reasons: [], amount: 1_000 }, 0)
      const agent = new DonorAgent(parseMandate({ name: 'x', mode: 'autopilot', keywords: ['air'] }), {
        ...deps(), api: { campaigns: async () => [], campaign: async () => view(edited) } as any,
        client: { vote: async (_c: string, _k: number, yes: boolean) => { votes.push(yes) } } as any,
        brain: new MockDonorBrain(), memos, log: () => {}
      })
      await agent.step()
      expect(votes, edited ? 'edited' : 'original').toEqual([!edited])
      if (edited) expect(memos.all().find(x => x.kind === 'vote')!.reasons.join(' ')).toMatch(/differs from the version anchored/)
    }
  })
})
