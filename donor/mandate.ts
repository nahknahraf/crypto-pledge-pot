/**
 * The donor's terms: what to support and the hard money limits.
 *
 * Everything that involves money in here is enforced by code (screen.ts and
 * donorAgent.ts), never by the language model. An invalid mandate is refused
 * at start-up.
 */

export type DonorMode = 'autopilot' | 'copilot'

export interface Mandate {
  name: string
  /**
   * autopilot: the agent pledges, votes and recovers on its own, from its own budget wallet.
   * copilot:   the agent proposes pledges with a memo; the donor approves and pays from their own wallet.
   */
  mode: DonorMode
  /** What the donor cares about, in their own words (given to the model as a description). */
  interests: string
  /** Cheap pre-filter: a campaign must mention at least one (case-insensitive). Empty = no filter. */
  keywords: string[]
  budget: {
    totalSats: number
    perPledgeMaxSats: number
    /** Max share of the total budget that may go to one creator (percent). */
    perCreatorMaxPct: number
  }
  requirements: {
    /** Creator must have at least this many completed campaigns (0 = newcomers welcome). */
    minCreatorCompleted: number
    /** Skip creators with more failed than completed campaigns. */
    rejectMostlyFailedCreators: boolean
    maxGoalSats: number
    /** Days between the funding deadline and the donor-only refund date (time to deliver). */
    minRefundWindowDays: number
    /** No milestone smaller than this share of the money (catches 1% / 99% splits). */
    minMilestonePercent: number
    agentCampaigns: 'allow' | 'only' | 'never'
  }
  /** Pledge only to campaigns scoring at least this (0–100). */
  scoreThreshold: number
  /** Optional name and message written on chain with each pledge. */
  memo?: { name?: string, message?: string }
  /** Co-pilot: the donor's identity key; approvals must come from pledges made by it. */
  donorIdentityKey?: string
}

export const DEFAULT_MANDATE: Mandate = {
  name: 'My giving',
  mode: 'copilot',
  interests: '',
  keywords: [],
  budget: { totalSats: 50_000, perPledgeMaxSats: 10_000, perCreatorMaxPct: 40 },
  requirements: {
    minCreatorCompleted: 0,
    rejectMostlyFailedCreators: true,
    maxGoalSats: 10_000_000,
    minRefundWindowDays: 7,
    minMilestonePercent: 10,
    agentCampaigns: 'allow'
  },
  scoreThreshold: 60
}

const MIN_PLEDGE = 100
const isInt = (n: unknown, min: number, max = Number.MAX_SAFE_INTEGER): boolean => Number.isSafeInteger(n) && (n as number) >= min && (n as number) <= max

/** Merge with defaults and validate. Throws a readable error for anything unsafe or nonsensical. */
export function parseMandate (input: unknown): Mandate {
  const raw = (typeof input === 'object' && input !== null ? input : {}) as Partial<Mandate>
  const m: Mandate = {
    ...DEFAULT_MANDATE,
    ...raw,
    budget: { ...DEFAULT_MANDATE.budget, ...(raw.budget ?? {}) },
    requirements: { ...DEFAULT_MANDATE.requirements, ...(raw.requirements ?? {}) }
  }
  const fail = (msg: string): never => { throw new Error(`invalid mandate: ${msg}`) }
  if (m.mode !== 'autopilot' && m.mode !== 'copilot') fail('mode must be "autopilot" or "copilot"')
  if (typeof m.name !== 'string' || m.name.trim() === '' || m.name.length > 80) fail('name must be 1–80 characters')
  if (typeof m.interests !== 'string' || m.interests.length > 1000) fail('interests must be text (at most 1000 characters)')
  if (!Array.isArray(m.keywords) || m.keywords.some(k => typeof k !== 'string' || k.trim() === '') || m.keywords.length > 30) fail('keywords must be up to 30 non-empty strings')
  if (m.interests.trim() === '' && m.keywords.length === 0) fail('give interests or keywords, so the agent knows what to look for')
  const b = m.budget
  if (!isInt(b.totalSats, MIN_PLEDGE)) fail(`budget.totalSats must be at least ${MIN_PLEDGE}`)
  if (!isInt(b.perPledgeMaxSats, MIN_PLEDGE, b.totalSats)) fail(`budget.perPledgeMaxSats must be between ${MIN_PLEDGE} and totalSats`)
  if (!isInt(b.perCreatorMaxPct, 1, 100)) fail('budget.perCreatorMaxPct must be 1–100')
  const r = m.requirements
  if (!isInt(r.minCreatorCompleted, 0, 1000)) fail('requirements.minCreatorCompleted must be 0 or more')
  if (typeof r.rejectMostlyFailedCreators !== 'boolean') fail('requirements.rejectMostlyFailedCreators must be true or false')
  if (!isInt(r.maxGoalSats, 1)) fail('requirements.maxGoalSats must be positive')
  if (!isInt(r.minRefundWindowDays, 0, 3650)) fail('requirements.minRefundWindowDays must be 0–3650')
  if (!isInt(r.minMilestonePercent, 1, 100)) fail('requirements.minMilestonePercent must be 1–100')
  if (!['allow', 'only', 'never'].includes(r.agentCampaigns)) fail('requirements.agentCampaigns must be allow, only or never')
  if (!isInt(m.scoreThreshold, 0, 100)) fail('scoreThreshold must be 0–100')
  if (m.donorIdentityKey !== undefined && !/^0[23][0-9a-f]{64}$/.test(m.donorIdentityKey)) fail('donorIdentityKey must be a compressed public key')
  return m
}
