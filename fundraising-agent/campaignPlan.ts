/**
 * The fundraising agent's campaign terms, derived from ONE spending plan so they can't contradict each
 * other: the goal, each milestone's share, the per-milestone spending cap and the description all come
 * from "N readings per milestone × the price per reading, plus a stated network-fee allowance".
 *
 * Found by the zero-click rehearsal with real Claude: hand-written terms raised 12,000 sats while
 * capping data spend at 250 sats per milestone, and promised 10 cities under a 5-reading cap. Careful
 * donor agents (rightly) refused to fund that.
 */
import type { LaunchInput } from '../client/cryptoPledgePot'

export interface SpendingPlan {
  /** Readings bought per milestone (each milestone the same, so one per-milestone cap fits them all). */
  readingsPerMilestone: number
  /** Price per reading, in sats: also the agent's hard price cap. */
  pricePerReading: number
  /** Network fees allowed per milestone (payment transactions, the report anchor, the release), in sats. */
  feeAllowancePerMilestone: number
  /** Who runs the agent and answers for it (shown in the terms when given). */
  operator?: string
}

export interface PlannedTerms {
  goal: number
  maxSpendPerMilestone: number
  milestones: LaunchInput['milestones']
  description: string
}

// Short titles (the platform limits a milestone title's length); "with a link to every payment" is in the description.
const MILESTONES = (n: number): string[] => [
  `First readings: ${n} cities`,
  `${n} more cities (${2 * n} in total)`,
  `Refresh the ${n} worst cities, publish dataset`
]

export function planCampaign (p: SpendingPlan): PlannedTerms {
  for (const [k, v] of Object.entries({ readingsPerMilestone: p.readingsPerMilestone, pricePerReading: p.pricePerReading, feeAllowancePerMilestone: p.feeAllowancePerMilestone })) {
    if (!Number.isSafeInteger(v) || v < (k === 'feeAllowancePerMilestone' ? 0 : 1)) throw new Error(`${k} must be a whole number${k === 'feeAllowancePerMilestone' ? ' ≥ 0' : ' ≥ 1'}`)
  }
  const data = p.readingsPerMilestone * p.pricePerReading
  const tranche = data + p.feeAllowancePerMilestone
  const goal = 3 * tranche
  const fmt = (n: number): string => n.toLocaleString('en-US')
  const description = [
    'I am an autonomous AI agent. I buy air-quality readings one at a time from a pay-per-call data shop and pay for each with a BSV micropayment.',
    'The shop resells Open-Meteo (CAMS) readings per call: the data is public; the point is to show an agent paying for what it uses, with every payment on chain.',
    `Budget, the same for each of the 3 milestones: ${p.readingsPerMilestone} readings × ${p.pricePerReading} sats = ${fmt(data)} sats of data, plus up to ${fmt(p.feeAllowancePerMilestone)} sats of network fees: ${fmt(tranche)} sats per milestone, ${fmt(goal)} sats in total.`,
    `My code enforces the spending limits published in these terms: at most ${p.pricePerReading} sats per reading and ${fmt(data)} sats of data per milestone. Unspent sats stay in my wallet and show in my public ledger.`,
    'Each report is hashed on chain before it is posted, so it cannot be edited later, and lists every payment. You only fund the next milestone after you have seen my report.',
    ...(p.operator !== undefined && p.operator.trim() !== '' ? [`Operated by: ${p.operator.trim()}.`] : [])
  ].join(' ')
  return {
    goal,
    maxSpendPerMilestone: data,
    milestones: MILESTONES(p.readingsPerMilestone).map((title, i) => ({ title, percent: i < 2 ? 33 : 34 })),
    description
  }
}
