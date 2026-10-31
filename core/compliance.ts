/**
 * Payment-plan compliance: did the NGO keep its promise for a released
 * milestone, and if not, what happens now?
 *
 *   release ──reportDays──▶ report due ──graceDays──▶ grace ends
 *   reporting               compliant ✓                cured ✓ / repaid ✓ / breached ✗
 *                           or grace starts
 *
 *  reporting  released; the NGO is still spending and reporting
 *  compliant  every budget line within tolerance by the report date
 *  grace      not compliant at the report date: the NGO has graceDays to
 *             report the missing lines or pay the unaccounted sats back
 *  cured      made compliant during the grace period
 *  repaid     paid the unaccounted sats back to the donors during the grace
 *             period, pro rata to what each pledge contributed to the milestone
 *  breached   none of that by the end of the grace period
 *
 * A breach stops all further releases and lets the arbiter co-sign early
 * refunds of every remaining escrow (server/policy.ts). The state is a pure
 * function of the data and the clock, so anyone can recompute it.
 */
import { P2PKH, PublicKey } from '@bsv/sdk'
import { evaluateSpending, type PaymentPlan, type SpendingResult, type VerifiedSpend } from './paymentPlan'

export type ComplianceState = 'reporting' | 'compliant' | 'grace' | 'cured' | 'repaid' | 'breached'
/** States in which the next milestone may be released. */
export const RESOLVED: readonly ComplianceState[] = ['compliant', 'cured', 'repaid']

const DAY = 86_400

export interface MilestoneCompliance {
  milestone: number
  state: ComplianceState
  releasedAt: number
  reportDueAt: number
  graceEndsAt: number
  /** Spending as it stands now (claims up to the end of the grace period). */
  spending: SpendingResult
  /** What must be paid back to resolve a non-compliant milestone. */
  dueBackSats: number
  /** Repaid to donors within the grace period, counted up to each pledge's share. */
  repaidSats: number
  /** One sentence for people. */
  detail: string
}

/** What one pledge put into milestone k's tranche (pro-rata basis for repayments). */
export interface Contribution { pledgeId: string, donorKey: string, sats: number }
export interface Repaid { pledgeId: string, sats: number, at: number }

/**
 * Split `total` over contributions pro rata, largest remainder first, so the
 * shares add up to exactly `total`.
 */
export function repaymentShares (total: number, contributions: Contribution[]): Map<string, number> {
  const sum = contributions.reduce((s, c) => s + c.sats, 0)
  const out = new Map<string, number>()
  if (sum === 0 || total <= 0) return new Map(contributions.map(c => [c.pledgeId, 0]))
  const exact = contributions.map(c => total * c.sats / sum)
  const floors = exact.map(Math.floor)
  let rest = total - floors.reduce((s, x) => s + x, 0)
  const order = exact.map((x, i) => [x - Math.floor(x), i] as const).sort((a, b) => b[0] - a[0] || a[1] - b[1])
  for (const [, i] of order) { if (rest <= 0) break; floors[i]++; rest-- }
  contributions.forEach((c, i) => out.set(c.pledgeId, floors[i]))
  return out
}

/** The script a repayment to a pledge pays: P2PKH of that pledge's donor key (the donor's wallet can spend it). */
export const repaymentScript = (donorKey: string): string =>
  new P2PKH().lock(PublicKey.fromString(donorKey).toHash() as number[]).toHex()

const fmt = (n: number): string => n.toLocaleString('en-US')
const date = (t: number): string => new Date(t * 1000).toISOString().slice(0, 10)

export function milestoneCompliance (a: {
  plan: PaymentPlan
  milestone: number
  releasedSats: number
  releasedAt: number
  spends: Array<VerifiedSpend & { at: number }>
  contributions: Contribution[]
  repaid: Repaid[]
  now: number
}): MilestoneCompliance {
  const { plan, milestone, releasedSats, releasedAt, now } = a
  const reportDueAt = releasedAt + plan.reportDays * DAY
  const graceEndsAt = reportDueAt + plan.graceDays * DAY
  const until = (t: number): SpendingResult => evaluateSpending(plan, milestone, releasedSats, a.spends.filter(s => s.at <= t))
  const byDue = until(reportDueAt)
  const spending = until(Math.min(now, graceEndsAt))
  const dueBackSats = spending.unaccountedSats
  const shares = repaymentShares(dueBackSats, a.contributions)
  const paid = new Map<string, number>()
  for (const r of a.repaid) if (r.at <= graceEndsAt) paid.set(r.pledgeId, (paid.get(r.pledgeId) ?? 0) + r.sats)
  const repaidSats = [...shares].reduce((s, [id, share]) => s + Math.min(paid.get(id) ?? 0, share), 0)
  const base = { milestone, releasedAt, reportDueAt, graceEndsAt, spending, dueBackSats, repaidSats }
  const missing = spending.lines.filter(l => !l.withinTolerance).map(l => `${l.category} (${l.deviationPercent}% off)`).join(', ')

  if (byDue.ok) return { ...base, dueBackSats: 0, state: 'compliant', detail: `Every budget line within ${plan.tolerancePercent}% of the plan.` }
  if (now < reportDueAt) return { ...base, state: 'reporting', detail: `Report due ${date(reportDueAt)}; still open: ${missing}.` }
  if (spending.ok) return { ...base, dueBackSats: 0, state: 'cured', detail: 'Fixed within the grace period.' }
  if (dueBackSats > 0 && shares.size > 0 && [...shares].every(([id, share]) => (paid.get(id) ?? 0) >= share)) {
    return { ...base, state: 'repaid', detail: `${fmt(repaidSats)} unaccounted sats paid back to the donors within the grace period.` }
  }
  if (now < graceEndsAt) {
    return { ...base, state: 'grace', detail: `Not compliant (${missing}). Until ${date(graceEndsAt)}: report the missing spending or pay back ${fmt(dueBackSats - repaidSats)} sats.` }
  }
  return { ...base, state: 'breached', detail: `Grace period over: ${fmt(dueBackSats)} sats unaccounted, ${fmt(repaidSats)} repaid. Remaining escrow is refundable.` }
}
