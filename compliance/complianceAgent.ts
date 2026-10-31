/**
 * The compliance agent: watches every campaign that has a payment plan and
 * holds the NGO to it.
 *
 * The rules themselves are enforced by the arbiter (server/policy.ts): the next
 * milestone is not co-signed until the last one's spending is resolved, and a
 * breach opens early refunds of the remaining escrow. This agent is the part
 * that acts on time:
 *
 *  - when a milestone is released it tells the NGO what to spend, on which
 *    lines and by when;
 *  - it reminds the NGO before the report date and before the grace period ends;
 *  - when the report date passes without a compliant report it opens the
 *    7-day grace period and tells the NGO and the donors what is missing and
 *    what must be paid back;
 *  - when the grace period ends without a fix or a repayment it writes a
 *    permanent breach record on chain (OP_RETURN) and tells the donors that
 *    they can reclaim the remaining escrow, and that the unaccounted sats can
 *    be claimed back from the NGO.
 *
 * Every verdict comes from core/compliance.ts, which is deterministic: anyone
 * can run this agent against the same index and reach the same verdicts.
 * step() is idempotent: every notice is sent once.
 */
import type { CampaignView } from '../core/api'
import type { BreachRecord } from '../core/campaign'
import type { ComplianceState, MilestoneCompliance } from '../core/compliance'
import type { CryptoPledgePotApi } from '../client/cryptoPledgePotApi'
import type { Store } from '../agent/ledger'

export type NoticeKind = 'opened' | 'reminder' | 'grace' | 'resolved' | 'breach'

export interface Notice {
  id: string
  at: number
  campaignId: string
  campaignTitle: string
  milestone: number
  kind: NoticeKind
  /** Who it is for: the NGO, the donors, or both. */
  to: 'ngo' | 'donors' | 'everyone'
  text: string
  /** Breach record transaction, once anchored. */
  txid?: string
}

export interface ComplianceAgentState {
  /** Last state seen per `campaignId:milestone`. */
  seen: Record<string, ComplianceState>
  /** Reminders already sent per `campaignId:milestone` (1 = report date, 2 = end of grace). */
  reminded: Record<string, number>
  /** Breach record txid per `campaignId:milestone` (missing = not anchored yet). */
  anchored: Record<string, string>
  notices: Notice[]
}

export const EMPTY_STATE: ComplianceAgentState = { seen: {}, reminded: {}, anchored: {}, notices: [] }

export interface ComplianceDeps {
  api: CryptoPledgePotApi
  store: Store<ComplianceAgentState>
  /** Write a breach record on chain; returns the txid. Optional: without it, breaches are only announced. */
  anchor?: (campaignId: string, record: BreachRecord) => Promise<string>
  /** Deliver a notice (webhook, e-mail bridge…). Failures are logged, never fatal. */
  notify?: (n: Notice) => Promise<void>
  /** Days before a deadline to remind the NGO (default 3). */
  remindBeforeDays?: number
  now?: () => number
  log?: (line: string) => void
}

export interface ComplianceStepSummary { campaigns: number, milestones: number, notices: number, breaches: number }

const DAY = 86_400
const fmt = (n: number): string => n.toLocaleString('en-US')
const date = (t: number): string => new Date(t * 1000).toISOString().slice(0, 10)

export class ComplianceAgent {
  private readonly log: (line: string) => void
  private readonly now: () => number

  constructor (readonly deps: ComplianceDeps) {
    this.log = deps.log ?? (line => console.log(`[compliance] ${line}`))
    this.now = deps.now ?? (() => Math.floor(Date.now() / 1000))
  }

  notices (): Notice[] { return this.deps.store.load().notices }

  async step (): Promise<ComplianceStepSummary> {
    const s: ComplianceStepSummary = { campaigns: 0, milestones: 0, notices: 0, breaches: 0 }
    const state = this.deps.store.load()
    const before = state.notices.length
    for (const c of await this.deps.api.campaigns()) {
      if (c.meta.paymentPlan === undefined) continue
      s.campaigns++
      for (const m of c.milestones) {
        if (m.compliance === undefined) continue
        s.milestones++
        if (await this.track(c, m.compliance, state)) s.breaches++
      }
    }
    this.deps.store.save(state)
    const fresh = state.notices.slice(before)
    for (const n of fresh) await this.deps.notify?.(n).catch(e => this.log(`could not deliver notice ${n.id}: ${(e as Error).message}`))
    s.notices = fresh.length
    return s
  }

  /** React to one milestone's compliance. Returns true when it newly breached. */
  private async track (c: CampaignView, x: MilestoneCompliance, state: ComplianceAgentState): Promise<boolean> {
    const key = `${c.id}:${x.milestone}`
    const prev = state.seen[key]
    const now = this.now()
    const plan = c.meta.paymentPlan!
    const say = (kind: NoticeKind, to: Notice['to'], text: string, txid?: string): void => {
      state.notices.push({ id: `n${state.notices.length + 1}`, at: now, campaignId: c.id, campaignTitle: c.meta.title, milestone: x.milestone, kind, to, text, txid })
      this.log(`"${c.meta.title}" milestone ${x.milestone}: ${text}`)
    }
    const open = x.spending.lines.filter(l => !l.withinTolerance)
      .map(l => `${l.category} → ${l.payee}: ${fmt(l.spentSats)} of ${fmt(l.plannedSats)} sats`).join('; ')
    const remind = (this.deps.remindBeforeDays ?? 3) * DAY
    state.seen[key] = x.state

    if (prev === undefined) {
      const lines = x.spending.lines.map(l => `${l.category} → ${l.payee}: ${fmt(l.plannedSats)} sats`).join('; ')
      say('opened', 'ngo', `${fmt(x.spending.releasedSats)} sats released. Spend them as planned (±${plan.tolerancePercent}%) and report every line by ${date(x.reportDueAt)}: ${lines}.`)
    }
    if (x.state === 'reporting' && now >= x.reportDueAt - remind && (state.reminded[key] ?? 0) < 1) {
      state.reminded[key] = 1
      say('reminder', 'ngo', `Report due ${date(x.reportDueAt)}. Still open: ${open}.`)
    }
    if (x.state === 'grace' && prev !== 'grace') {
      say('grace', 'everyone', `Not in line with the payment plan at the report date (${open}). Grace period until ${date(x.graceEndsAt)}: the NGO must report the missing spending or pay ${fmt(x.dueBackSats - x.repaidSats)} sats back to the donors. Releases are on hold.`)
    }
    if (x.state === 'grace' && now >= x.graceEndsAt - Math.min(remind, plan.graceDays * DAY / 2) && (state.reminded[key] ?? 0) < 2) {
      state.reminded[key] = 2
      say('reminder', 'ngo', `Grace period ends ${date(x.graceEndsAt)}. Report the missing spending or repay ${fmt(x.dueBackSats - x.repaidSats)} sats, or the campaign is declared in breach and the remaining escrow goes back to the donors.`)
    }
    if ((x.state === 'compliant' || x.state === 'cured' || x.state === 'repaid') && prev !== x.state) {
      say('resolved', 'everyone', x.detail)
    }
    if (x.state !== 'breached') return false

    let fresh = false
    if (prev !== 'breached') {
      fresh = true
      say('breach', 'everyone', `Breach of the payment plan: ${fmt(x.dueBackSats)} sats unaccounted after the grace period, ${fmt(x.repaidSats)} repaid. ` +
        'No further milestones will be released. Donors: reclaim your remaining escrow now (the arbiter co-signs early refunds); ' +
        'the unaccounted sats can be claimed back from the NGO under the signed terms.')
    }
    if (this.deps.anchor !== undefined && state.anchored[key] === undefined) {
      try {
        const txid = await this.deps.anchor(c.id, {
          milestone: x.milestone,
          unaccountedSats: x.dueBackSats,
          repaidSats: x.repaidSats,
          graceEndedAt: x.graceEndsAt,
          lines: x.spending.lines.map(l => ({ lineId: l.lineId, plannedSats: l.plannedSats, spentSats: l.spentSats }))
        })
        state.anchored[key] = txid
        const breach = [...state.notices].reverse().find(n => n.kind === 'breach' && n.campaignId === c.id && n.milestone === x.milestone)
        if (breach !== undefined) breach.txid = txid
        this.log(`breach record for "${c.meta.title}" milestone ${x.milestone} anchored: ${txid}`)
      } catch (e) {
        this.log(`could not anchor the breach record (will retry): ${(e as Error).message}`)
      }
    }
    return fresh
  }
}
