/**
 * The donor agent: gives on someone's behalf, within their terms.
 *
 *  autopilot  The donor funds the agent's own wallet with the budget and sets
 *             the terms. The agent finds campaigns, does the due diligence,
 *             pledges, verifies each milestone report and votes, and reclaims
 *             money from failed or expired campaigns.
 *  copilot    The agent finds and checks campaigns the same way, but only
 *             PROPOSES: a short memo with the amount, the score and the
 *             reasons. The donor approves and pays from their own wallet; the
 *             agent then verifies that pledge before marking it done.
 *
 * Money rules live in code (screen.ts); the brain only judges. step() is safe
 * to call repeatedly: every campaign is evaluated once, every vote cast once.
 */
import type { CampaignView } from '../core/api'
import type { CryptoPledgePot } from '../client/cryptoPledgePot'
import type { CryptoPledgePotApi } from '../client/cryptoPledgePotApi'
import { addressesAgents, MANIPULATION, type DonorBrain } from './brain'
import { checkAgent, checkAnchor, checkArbiter, checkReportAnchor, verifiedPaymentsIn, type Check, type DiligenceDeps } from './diligence'
import type { Mandate } from './mandate'
import type { Memo, MemoBook } from './memo'
import { amountFor, creatorRecord, screen, type Portfolio } from './screen'
import { scoreCampaign } from './score'

export interface DonorDeps extends DiligenceDeps {
  api: CryptoPledgePotApi
  brain: DonorBrain
  memos: MemoBook
  /** Autopilot only: the client bound to the agent's own budget wallet. */
  client?: CryptoPledgePot
  now?: () => number
  log?: (line: string) => void
  /** New campaigns evaluated per step (each costs lookups and a model call); the rest wait for the next step. Default 25. */
  maxEvaluationsPerStep?: number
}

export interface StepSummary { evaluated: number, proposed: number, pledged: number, skipped: number, votes: number, refunds: number }

export class DonorAgent {
  private readonly log: (line: string) => void
  private readonly now: () => number

  constructor (readonly mandate: Mandate, readonly deps: DonorDeps) {
    if (mandate.mode === 'autopilot' && deps.client === undefined) throw new Error('autopilot needs a wallet client (the agent\'s budget wallet)')
    this.log = deps.log ?? (line => console.log(`[donor] ${line}`))
    this.now = deps.now ?? (() => Math.floor(Date.now() / 1000))
  }

  /** What has been given or reserved so far: executed pledges plus open proposals. */
  portfolio (campaigns: CampaignView[] = []): Portfolio {
    const p: Portfolio = { byCampaign: {}, byCreator: {}, total: 0 }
    const creatorOf = new Map(campaigns.map(c => [c.id, c.meta.creatorIdentityKey]))
    for (const m of this.deps.memos.all()) {
      if (m.kind === 'skip' || (m.kind === 'pledge' && (m.status === 'declined' || m.status === 'skipped'))) { p.byCampaign[m.campaignId] ??= 0; continue }
      if (m.kind !== 'pledge' || (m.status !== 'executed' && m.status !== 'proposed') || m.amount === undefined) continue
      p.byCampaign[m.campaignId] = (p.byCampaign[m.campaignId] ?? 0) + m.amount
      p.total += m.amount
      const creator = creatorOf.get(m.campaignId)
      if (creator !== undefined) p.byCreator[creator] = (p.byCreator[creator] ?? 0) + m.amount
    }
    return p
  }

  async step (): Promise<StepSummary> {
    const s: StepSummary = { evaluated: 0, proposed: 0, pledged: 0, skipped: 0, votes: 0, refunds: 0 }
    const campaigns = await this.deps.api.campaigns()
    // A proposal the donor never answered expires when its campaign closes: it stops reserving budget.
    const open = new Set(campaigns.filter(c => c.status === 'active').map(c => c.id))
    for (const m of this.deps.memos.all().filter(x => x.kind === 'pledge' && x.status === 'proposed' && !open.has(x.campaignId))) {
      this.deps.memos.update(m.id, { status: 'declined', reasons: [...m.reasons, 'expired: the campaign closed before you approved'] })
      this.log(`proposal for "${m.campaignTitle}" expired`)
    }
    // Proposals made under an older mandate (the donor changed it and restarted) must still fit the current one.
    for (const m of this.deps.memos.all().filter(x => x.kind === 'pledge' && x.status === 'proposed')) {
      const c = campaigns.find(x => x.id === m.campaignId)
      if (c === undefined) continue
      const empty = { byCampaign: {}, byCreator: {}, total: 0 }
      const rules = screen(c, this.mandate, creatorRecord(campaigns, c.meta.creatorIdentityKey, c.id), empty, this.now())
      const why = !rules.ok ? rules.failed[0] : (m.amount ?? 0) > this.mandate.budget.perPledgeMaxSats ? `more than your per-pledge limit of ${this.mandate.budget.perPledgeMaxSats} sats` : undefined
      if (why !== undefined) {
        this.deps.memos.update(m.id, { status: 'declined', reasons: [...m.reasons, `no longer fits your mandate: ${why}`] })
        this.log(`proposal for "${m.campaignTitle}" withdrawn: ${why}`)
      }
    }
    // Decided campaigns are not looked at again; a pledge that FAILED (wallet offline, broadcast error)
    // is retried on later steps, up to 3 attempts, since it spent nothing.
    const memos = this.deps.memos.all()
    const failures = (id: string): number => memos.filter(m => m.campaignId === id && m.kind === 'pledge' && m.status === 'failed').length
    const seen = new Set(memos.filter(m => m.kind === 'skip' || (m.kind === 'pledge' && (m.status !== 'failed' || failures(m.campaignId) >= 3))).map(m => m.campaignId))
    for (const c of campaigns) {
      if (seen.has(c.id) || c.status !== 'active') continue
      if (s.evaluated >= (this.deps.maxEvaluationsPerStep ?? 25)) break // bounded cost per round
      s.evaluated++
      const memo = await this.evaluate(c, campaigns)
      if (memo.kind === 'skip') s.skipped++
      else if (memo.status === 'proposed') s.proposed++
      else if (memo.status === 'executed') s.pledged++
    }
    if (this.mandate.mode === 'autopilot') {
      s.votes = await this.monitor()
      s.refunds = await this.recover()
    }
    return s
  }

  /** Hard rules → due diligence → judgement → score → amount → pledge (autopilot) or proposal (co-pilot). */
  private async evaluate (c: CampaignView, all: CampaignView[]): Promise<Memo> {
    const now = this.now()
    const record = creatorRecord(all, c.meta.creatorIdentityKey, c.id)
    const portfolio = this.portfolio(all)
    const base = { campaignId: c.id, campaignTitle: c.meta.title }
    const skip = (reasons: string[], checks: Check[], extra: Partial<Memo> = {}): Memo => {
      this.log(`skip "${c.meta.title}": ${reasons.join('; ')}`)
      return this.deps.memos.add({ ...base, kind: 'skip', status: 'skipped', summary: `Not funded: ${reasons[0]}.`, checks, reasons, ...extra }, now)
    }

    const rules = screen(c, this.mandate, record, portfolio, now)
    const checks: Check[] = [...rules.passed.map(d => ({ name: 'rule', ok: true, detail: d })), ...rules.failed.map(d => ({ name: 'rule', ok: false, detail: d }))]
    if (!rules.ok) return skip(rules.failed, checks)

    const diligence = [await checkAnchor(c, this.deps), await checkArbiter(c, this.deps)]
    checks.push(...diligence)
    const fatal = diligence.filter(d => !d.ok)
    if (fatal.length > 0) return skip(fatal.map(d => d.detail), checks)
    const agent = await checkAgent(c, this.deps)
    if (agent !== undefined) checks.push(agent)

    let assessment
    try {
      assessment = await this.deps.brain.assessCampaign(this.mandate, c)
    } catch (e) {
      return skip([`could not assess it (${(e as Error).message})`], checks)
    }
    if (agent !== undefined && !agent.ok) assessment.riskFlags.push(`AI agent: ${agent.detail}`)
    // A hard rule, whatever the brain said: text that addresses AI agents disqualifies (score.ts).
    const fields = [c.meta.title, c.meta.description, ...c.meta.milestones.map(m => m.title)].join(' \n ')
    if (addressesAgents(fields) && !assessment.riskFlags.some(f => f.startsWith(MANIPULATION))) assessment.riskFlags.push(`${MANIPULATION}text addressed to AI agents`)
    const score = scoreCampaign(c, assessment, record, now)
    if (score.total < this.mandate.scoreThreshold) {
      return skip([`score ${score.total} is below your threshold of ${this.mandate.scoreThreshold}`], checks, { score, summary: `Not funded (score ${score.total}): ${assessment.summary}` })
    }
    const amount = amountFor(c, this.mandate, portfolio, score.total)
    if (amount === 0) return skip(['no budget left under your limits'], checks, { score })

    const reasons = [`score ${score.total}/100`, ...score.parts.filter(p => p.points > 0).map(p => `${p.name}: ${p.why}`), ...assessment.riskFlags.map(f => `risk: ${f}`)]
    const summary = `${assessment.summary} Score ${score.total}/100. ${this.mandate.mode === 'copilot' ? 'Proposed' : 'Pledged'} ${amount.toLocaleString('en-US')} sats.`
    if (this.mandate.mode === 'copilot') {
      this.log(`propose ${amount} sats to "${c.meta.title}" (score ${score.total})`)
      return this.deps.memos.add({ ...base, kind: 'pledge', status: 'proposed', summary, checks, reasons, score, amount }, now)
    }
    try {
      const pledge = await this.deps.client!.donate(c.meta, amount, this.mandate.memo ?? {})
      this.log(`pledged ${amount} sats to "${c.meta.title}" (score ${score.total})`)
      return this.deps.memos.add({ ...base, kind: 'pledge', status: 'executed', summary, checks, reasons, score, amount, pledgeId: pledge.id, txid: pledge.id.split('.')[0] }, now)
    } catch (e) {
      this.log(`pledge to "${c.meta.title}" failed: ${(e as Error).message}`)
      return this.deps.memos.add({ ...base, kind: 'pledge', status: 'failed', summary, checks, reasons, score, amount, error: (e as Error).message }, now)
    }
  }

  /** Hard rules first, then the brain. Anchor edited after the fact → reject; anchor unverifiable → abstain; text addressing AI agents → reject. */
  private async judgeReport (c: CampaignView, milestone: number, note: string, verifiedPayments: number): Promise<{ verdict: 'approve' | 'reject' | 'unsure', reasons: string[] }> {
    const anchor = await checkReportAnchor(c, milestone, note, this.deps)
    if (anchor?.outcome === 'mismatch') return { verdict: 'reject', reasons: [anchor.detail] }
    if (anchor?.outcome === 'unverifiable') return { verdict: 'unsure', reasons: [anchor.detail] }
    if (addressesAgents(note)) return { verdict: 'reject', reasons: ['the report contains text addressed to AI agents'] }
    return await this.deps.brain.assessReport(this.mandate, c, milestone, note, verifiedPayments)
      .catch(e => ({ verdict: 'unsure' as const, reasons: [`could not assess (${(e as Error).message})`] }))
  }

  /** Autopilot: read each new milestone report of the campaigns we backed, verify its evidence, vote. */
  private async monitor (): Promise<number> {
    let votes = 0
    const memos = this.deps.memos.all()
    const done = new Set(memos.filter(m => m.kind === 'vote').map(m => `${m.campaignId}:${m.milestone ?? 0}`))
    for (const p of memos.filter(m => m.kind === 'pledge' && m.status === 'executed')) {
      const c = await this.deps.api.campaign(p.campaignId)
      for (const ms of c.milestones) {
        if (ms.index < 2 || ms.released || ms.update === undefined || done.has(`${c.id}:${ms.index}`)) continue
        done.add(`${c.id}:${ms.index}`)
        const evidence = await verifiedPaymentsIn(ms.update.note, this.deps)
        const verdict = await this.judgeReport(c, ms.index, ms.update.note, evidence.verified)
        const reasons = [`${evidence.verified}/${evidence.linked} linked payment(s) verified on chain`, ...verdict.reasons]
        const memo = { campaignId: c.id, campaignTitle: c.meta.title, kind: 'vote' as const, milestone: ms.index, checks: [], reasons }
        if (verdict.verdict === 'unsure') {
          this.deps.memos.add({ ...memo, status: 'skipped', vote: 'abstain', summary: `Abstained on milestone ${ms.index}: ${verdict.reasons[0] ?? 'not enough evidence'}.` }, this.now())
          continue
        }
        const approve = verdict.verdict === 'approve'
        try {
          await this.deps.client!.vote(c.id, ms.index, approve)
          votes++
          this.log(`voted ${approve ? 'YES' : 'NO'} on "${c.meta.title}" milestone ${ms.index}`)
          this.deps.memos.add({ ...memo, status: 'executed', vote: approve ? 'yes' : 'no', summary: `Voted ${approve ? 'YES' : 'NO'} on milestone ${ms.index}: ${verdict.reasons[0] ?? ''}` }, this.now())
        } catch (e) {
          this.deps.memos.add({ ...memo, status: 'failed', vote: approve ? 'yes' : 'no', summary: `Vote on milestone ${ms.index} failed.`, error: (e as Error).message }, this.now())
        }
      }
    }
    return votes
  }

  /** Autopilot: take money back from failed campaigns (arbiter-assisted) and from escrows past their refund date. */
  private async recover (): Promise<number> {
    let refunds = 0
    const now = this.now()
    const refunded = new Set(this.deps.memos.all().filter(m => m.kind === 'refund' && m.status === 'executed').map(m => m.pledgeId))
    for (const p of this.deps.memos.all().filter(m => m.kind === 'pledge' && m.status === 'executed' && m.pledgeId !== undefined)) {
      if (refunded.has(p.pledgeId)) continue
      const { pledge } = await this.deps.api.pledge(p.pledgeId!)
      if (pledge.status !== 'active') continue
      const c = await this.deps.api.campaign(p.campaignId)
      const mode = c.status === 'failed' ? 'failed' : now >= c.meta.refundAfter && c.status !== 'completed' ? 'deadline' : undefined
      if (mode === undefined) continue
      const memo = { campaignId: c.id, campaignTitle: c.meta.title, kind: 'refund' as const, pledgeId: p.pledgeId, checks: [], reasons: [mode === 'failed' ? 'the campaign missed its goal' : 'the refund date has passed'] }
      try {
        const r = await this.deps.client!.refund(p.pledgeId!, mode, now)
        refunds++
        this.log(`reclaimed ${r.satoshis} sats from "${c.meta.title}" (${mode})`)
        this.deps.memos.add({ ...memo, status: 'executed', amount: r.satoshis, txid: r.txid, summary: `Reclaimed ${r.satoshis} sats: ${memo.reasons[0]}.` }, now)
      } catch (e) {
        this.deps.memos.add({ ...memo, status: 'failed', summary: 'Reclaiming failed; will retry.', error: (e as Error).message }, now)
      }
    }
    return refunds
  }

  // ── co-pilot: the donor's decisions ─────────────────────────────────────

  /**
   * The donor approved a proposal and paid from their own wallet. Verify that
   * pledge in the index (right campaign, not more than proposed, made by the
   * donor's identity) before marking the proposal done.
   */
  async approve (memoId: string, pledgeId: string): Promise<Memo> {
    const memo = this.deps.memos.get(memoId)
    if (memo?.kind !== 'pledge' || memo.status !== 'proposed') throw new Error('not an open proposal')
    const { pledge } = await this.deps.api.pledge(pledgeId)
    if (pledge.campaignId !== memo.campaignId) throw new Error('that pledge is for a different campaign')
    if (pledge.amount > (memo.amount ?? 0)) throw new Error(`that pledge (${pledge.amount} sats) is more than proposed (${memo.amount ?? 0})`)
    if (this.mandate.donorIdentityKey !== undefined && pledge.donorIdentity !== this.mandate.donorIdentityKey) throw new Error('that pledge was not made by the donor\'s wallet')
    this.log(`donor approved and paid ${pledge.amount} sats to "${memo.campaignTitle}"`)
    return this.deps.memos.update(memoId, { status: 'executed', amount: pledge.amount, pledgeId, txid: pledgeId.split('.')[0] })
  }

  decline (memoId: string): Memo {
    const memo = this.deps.memos.get(memoId)
    if (memo?.kind !== 'pledge' || memo.status !== 'proposed') throw new Error('not an open proposal')
    this.log(`donor declined "${memo.campaignTitle}"`)
    return this.deps.memos.update(memoId, { status: 'declined' })
  }
}
