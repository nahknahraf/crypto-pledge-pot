/**
 * The arbiter's policy: when does the CryptoPledgePot vote oracle co-sign?
 *
 *  - Milestone 1 is released once the campaign is funded: the deadline has
 *    passed and the goal was met (all-or-nothing).
 *  - Milestone k ≥ 2 needs milestone k-1 released, a progress update from the
 *    creator, and a majority donor vote: YES weight > 50% of all satoshis still
 *    pledged. Each donor's vote weighs what they pledged.
 *  - An early refund (refundFailed) is co-signed only when the campaign failed.
 *
 * Donors never depend on this policy to get their money back: after
 * `refundAfter` the contract lets them reclaim the remaining escrow alone.
 */
import { campaignStatus, type CampaignMeta } from '../core/campaign'
import { escrowedAfter, cumulativeSchedule } from '../core/pledge'
import type { CampaignView, MilestoneView, PledgeView } from '../core/api'
import type { CampaignRow, PledgeRow, ReleaseRow, UpdateRow, VoteRow } from './db'

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
  now: number
): CampaignView {
  const meta = c.meta
  const counted = pledges.filter(p => p.status !== 'refunded')
  const raised = counted.reduce((s, p) => s + p.amount, 0)
  const escrowed = counted.reduce((s, p) => s + pledgeView(meta, p).escrowed, 0)
  const releasedMilestones = new Set(releases.map(r => r.milestone))
  const milestonesReleased = meta.milestones.findIndex((_, i) => !releasedMilestones.has(i + 1))
  const releasedCount = milestonesReleased === -1 ? meta.milestones.length : milestonesReleased
  const status = campaignStatus(meta, raised, releasedCount, now)

  // Vote weight: satoshis each donor still has pledged.
  const weight = new Map<string, number>()
  for (const p of counted) weight.set(p.donorIdentity, (weight.get(p.donorIdentity) ?? 0) + p.amount)

  const milestones: MilestoneView[] = meta.milestones.map((m, i) => {
    const index = i + 1
    const update = updates.find(u => u.milestone === index)
    const ballots = votes.filter(v => v.milestone === index && weight.has(v.voter))
    const yes = ballots.filter(v => v.approve).reduce((s, v) => s + weight.get(v.voter)!, 0)
    const no = ballots.filter(v => !v.approve).reduce((s, v) => s + weight.get(v.voter)!, 0)
    let pending: string | undefined
    if (status === 'active') pending = 'campaign still raising'
    else if (status === 'failed') pending = 'campaign missed its goal'
    else if (index > 1 && !releasedMilestones.has(index - 1)) pending = `milestone ${index - 1} not released yet`
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
      pending
    }
  })

  return {
    id: c.id,
    meta,
    anchorTxid: c.anchorTxid,
    status,
    raised,
    released: releases.reduce((s, r) => s + r.amount, 0),
    escrowed,
    donors: weight.size,
    pledges: counted.length,
    milestonesReleased: releasedCount,
    milestones
  }
}

/** May the arbiter co-sign moving `pledge` from its stage to the next? */
export function mayRelease (view: CampaignView, pledge: PledgeRow): boolean {
  if (pledge.status !== 'active' || pledge.campaignId !== view.id) return false
  const milestone = view.milestones[pledge.stage]
  return milestone !== undefined && milestone.approved
}

/** May the arbiter co-sign an early refund of `pledge`? */
export const mayRefundEarly = (view: CampaignView, pledge: PledgeRow): boolean =>
  pledge.status === 'active' && pledge.campaignId === view.id && view.status === 'failed'
