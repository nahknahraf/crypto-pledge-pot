/**
 * The arbiter's policy: when does the CryptoPledgePot vote oracle co-sign?
 *
 *  - Milestone 1 is released once the campaign is funded: the deadline has
 *    passed and the goal was met (all-or-nothing).
 *  - Milestone k ≥ 2 needs milestone k-1 released, a progress update from the
 *    creator, and a majority donor vote: YES weight > 50% of all satoshis still
 *    pledged. Each donor's vote weighs what they pledged.
 *  - With a payment plan, milestone k ≥ 2 also needs milestone k-1's spending
 *    resolved: compliant, cured or repaid (core/compliance.ts).
 *  - An early refund (refundFailed) is co-signed only when the campaign failed,
 *    or breached its payment plan.
 *
 * Donors never depend on this policy to get their money back: after
 * `refundAfter` the contract lets them reclaim the remaining escrow alone.
 */
import { campaignStatus, type CampaignMeta } from '../core/campaign'
import { escrowedAfter, cumulativeSchedule } from '../core/pledge'
import { milestoneCompliance, RESOLVED, type Contribution, type MilestoneCompliance } from '../core/compliance'
import type { CampaignView, MilestoneView, PledgeView } from '../core/api'
import type { CampaignRow, PledgeRow, ReleaseRow, RepaymentRow, SpendRow, UpdateRow, VoteRow } from './db'

export function pledgeView (meta: CampaignMeta, p: PledgeRow): PledgeView {
  const schedule = { pledged: p.amount, cumulativeBps: cumulativeSchedule(meta.milestones.map(m => m.percent)) }
  return { ...p, escrowed: p.status === 'active' ? escrowedAfter(schedule, p.stage) : 0 }
}

export function campaignView (
  c: CampaignRow,
  pledges: PledgeRow[],
  releases: ReleaseRow[],
  updates: UpdateRow[],
  votes: VoteRow[],
  now: number,
  plan: { spends: SpendRow[], repayments: RepaymentRow[] } = { spends: [], repayments: [] }
): CampaignView {
  const meta = c.meta
  const counted = pledges.filter(p => p.status !== 'refunded')
  const raised = counted.reduce((s, p) => s + p.amount, 0)
  const escrowed = counted.reduce((s, p) => s + pledgeView(meta, p).escrowed, 0)
  const releasedMilestones = new Set(releases.map(r => r.milestone))
  const milestonesReleased = meta.milestones.findIndex((_, i) => !releasedMilestones.has(i + 1))
  const releasedCount = milestonesReleased === -1 ? meta.milestones.length : milestonesReleased
  const compliance = meta.milestones.map((_, i) => releasedMilestones.has(i + 1) ? complianceOf(meta, i + 1, pledges, releases, plan, now) : undefined)
  const status = compliance.some(x => x?.state === 'breached') ? 'breached' : campaignStatus(meta, raised, releasedCount, now)

  // Vote weight: satoshis each donor still has pledged.
  const weight = new Map<string, number>()
  for (const p of counted) if (p.donorIdentity !== '') weight.set(p.donorIdentity, (weight.get(p.donorIdentity) ?? 0) + p.amount)

  const milestones: MilestoneView[] = meta.milestones.map((m, i) => {
    const index = i + 1
    const update = updates.find(u => u.milestone === index)
    const ballots = votes.filter(v => v.milestone === index && weight.has(v.voter))
    const yes = ballots.filter(v => v.approve).reduce((s, v) => s + weight.get(v.voter)!, 0)
    const no = ballots.filter(v => !v.approve).reduce((s, v) => s + weight.get(v.voter)!, 0)
    let pending: string | undefined
    if (status === 'active') pending = 'campaign still raising'
    else if (status === 'failed') pending = 'campaign missed its goal'
    else if (status === 'breached') pending = 'the creator breached its payment plan; donors can reclaim the remaining escrow'
    else if (index > 1 && !releasedMilestones.has(index - 1)) pending = `milestone ${index - 1} not released yet`
    else if (index > 1 && compliance[i - 1] !== undefined && !RESOLVED.includes(compliance[i - 1]!.state)) pending = `milestone ${index - 1} spending is not yet in line with the payment plan (${compliance[i - 1]!.state})`
    else if (index > 1 && update === undefined) pending = 'waiting for the creator\'s progress update'
    else if (index > 1 && yes * 2 <= raised) pending = 'needs YES votes from donors holding more than 50% of pledged sats'
    return {
      index,
      title: m.title,
      percent: m.percent,
      released: releasedMilestones.has(index),
      releaseTxids: releases.filter(r => r.milestone === index).map(r => r.txid),
      update: update !== undefined ? { note: update.note, createdAt: update.createdAt } : undefined,
      votes: { yes, no, voters: ballots.length },
      approved: pending === undefined && raised > 0,
      pending,
      spending: compliance[i]?.spending,
      compliance: compliance[i]
    }
  })

  return {
    id: c.id,
    meta,
    anchorTxid: c.anchorTxid,
    protocolTag: c.protocolTag,
    status,
    raised,
    released: releases.reduce((s, r) => s + r.amount, 0),
    escrowed,
    donors: weight.size + counted.filter(p => p.donorIdentity === '').length, // unclaimed imports count as one donor each
    pledges: counted.length,
    milestonesReleased: releasedCount,
    milestones
  }
}

/** What each pledge contributed to milestone k (pledges that have passed stage k). */
export function contributions (meta: CampaignMeta, pledges: PledgeRow[], k: number): Contribution[] {
  const cumulativeBps = cumulativeSchedule(meta.milestones.map(m => m.percent))
  return pledges.filter(p => p.stage >= k).map(p => ({
    pledgeId: p.id,
    donorKey: p.donorKey,
    sats: escrowedAfter({ pledged: p.amount, cumulativeBps }, k - 1) - escrowedAfter({ pledged: p.amount, cumulativeBps }, k)
  }))
}

function complianceOf (meta: CampaignMeta, k: number, pledges: PledgeRow[], releases: ReleaseRow[], plan: { spends: SpendRow[], repayments: RepaymentRow[] }, now: number): MilestoneCompliance | undefined {
  if (meta.paymentPlan === undefined) return undefined
  return milestoneCompliance({
    plan: meta.paymentPlan,
    milestone: k,
    releasedSats: releasedFor(releases, k),
    releasedAt: Math.min(...releases.filter(r => r.milestone === k).map(r => r.createdAt)),
    spends: plan.spends.filter(s => s.milestone === k).map(s => ({ lineId: s.lineId, verifiedSats: s.verifiedSats, ok: true, reason: s.reason, at: s.createdAt })),
    contributions: contributions(meta, pledges, k),
    repaid: plan.repayments.filter(r => r.milestone === k).map(r => ({ pledgeId: r.pledgeId, sats: r.sats, at: r.createdAt })),
    now
  })
}

/** Satoshis released to the creator for milestone k (over all release transactions). */
export const releasedFor = (releases: ReleaseRow[], k: number): number =>
  releases.filter(r => r.milestone === k).reduce((s, r) => s + r.amount, 0)

/** May the arbiter co-sign moving `pledge` from its stage to the next? */
export function mayRelease (view: CampaignView, pledge: PledgeRow): boolean {
  if (pledge.status !== 'active' || pledge.campaignId !== view.id) return false
  const milestone = view.milestones[pledge.stage]
  return milestone !== undefined && milestone.approved
}

/** May the arbiter co-sign an early refund of `pledge`? */
export const mayRefundEarly = (view: CampaignView, pledge: PledgeRow): boolean =>
  pledge.status === 'active' && pledge.campaignId === view.id && (view.status === 'failed' || view.status === 'breached')
