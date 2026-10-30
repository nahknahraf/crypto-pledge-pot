/**
 * Hard rules: pure functions, no model, no network. A campaign that fails any
 * rule is skipped with the reason; amounts come only from here.
 */
import type { CampaignView } from '../core/api'
import type { Mandate } from './mandate'

export interface CreatorRecord { completed: number, failed: number, active: number }

export interface Portfolio {
  /** Sats this donor already pledged per campaign id (including proposals awaiting approval). */
  byCampaign: Record<string, number>
  /** Sats per creator identity key. */
  byCreator: Record<string, number>
  /** Total pledged so far (including proposals awaiting approval). */
  total: number
}

export interface ScreenResult { ok: boolean, passed: string[], failed: string[] }

const DAY = 86_400

/** Every campaign by `creatorIdentityKey` in `all`, as completed / failed / active counts. */
export function creatorRecord (all: CampaignView[], creatorIdentityKey: string, exceptId?: string): CreatorRecord {
  const r: CreatorRecord = { completed: 0, failed: 0, active: 0 }
  for (const c of all) {
    if (c.meta.creatorIdentityKey !== creatorIdentityKey || c.id === exceptId) continue
    if (c.status === 'completed') r.completed++
    else if (c.status === 'failed' || c.status === 'breached') r.failed++
    else r.active++
  }
  return r
}

export function screen (c: CampaignView, m: Mandate, record: CreatorRecord, portfolio: Portfolio, now: number): ScreenResult {
  const passed: string[] = []
  const failed: string[] = []
  const check = (ok: boolean, yes: string, no: string): void => { (ok ? passed : failed).push(ok ? yes : no) }

  check(c.status === 'active' && now < c.meta.deadline, 'still raising', `not raising any more (${c.status})`)
  check(portfolio.byCampaign[c.id] === undefined, 'not pledged to yet', 'already pledged to (or proposed)')

  if (m.keywords.length > 0) {
    const text = `${c.meta.title} ${c.meta.description} ${c.meta.milestones.map(x => x.title).join(' ')}`.toLowerCase()
    const hit = m.keywords.find(k => text.includes(k.toLowerCase()))
    check(hit !== undefined, `mentions "${hit ?? ''}"`, `mentions none of: ${m.keywords.join(', ')}`)
  }

  const isAgent = c.meta.kind === 'agent'
  if (m.requirements.agentCampaigns === 'never') check(!isAgent, 'run by people', 'run by an AI agent (mandate: never)')
  if (m.requirements.agentCampaigns === 'only') check(isAgent, 'run by an AI agent', 'not an AI agent campaign (mandate: only agents)')

  check(c.meta.goal <= m.requirements.maxGoalSats, `goal ${c.meta.goal} sats within limit`, `goal ${c.meta.goal} sats above the ${m.requirements.maxGoalSats} limit`)
  const windowDays = Math.floor((c.meta.refundAfter - c.meta.deadline) / DAY)
  check(windowDays >= m.requirements.minRefundWindowDays, `${windowDays} days to deliver before self-refund`, `only ${windowDays} days between deadline and refund date (minimum ${m.requirements.minRefundWindowDays})`)
  const smallest = Math.min(...c.meta.milestones.map(x => x.percent))
  check(smallest >= m.requirements.minMilestonePercent, 'milestones evenly enough split', `a milestone of only ${smallest}% (minimum ${m.requirements.minMilestonePercent}%)`)

  check(record.completed >= m.requirements.minCreatorCompleted,
    `creator completed ${record.completed} campaign(s)`, `creator completed ${record.completed} campaign(s), mandate requires ${m.requirements.minCreatorCompleted}`)
  if (m.requirements.rejectMostlyFailedCreators) {
    check(record.failed <= record.completed, 'creator has not failed more than delivered', `creator failed ${record.failed} and completed ${record.completed}`)
  }

  check(amountFor(c, m, portfolio, 100) >= 100, 'budget left for a pledge', 'no budget left under the mandate limits')
  return { ok: failed.length === 0, passed, failed }
}

/**
 * How much to pledge. Code only:
 *  - scaled by score (≥90: full, ≥75: 3/4, else 1/2 of perPledgeMax);
 *  - never above the remaining total budget or the per-creator cap;
 *  - rounded down to 100 sats; 0 if under the 100-sat minimum pledge.
 */
export function amountFor (c: CampaignView, m: Mandate, portfolio: Portfolio, score: number): number {
  const scale = score >= 90 ? 1 : score >= 75 ? 0.75 : 0.5
  const remainingTotal = m.budget.totalSats - portfolio.total
  const creatorCap = Math.floor(m.budget.totalSats * m.budget.perCreatorMaxPct / 100) - (portfolio.byCreator[c.meta.creatorIdentityKey] ?? 0)
  const raw = Math.min(Math.floor(m.budget.perPledgeMaxSats * scale), remainingTotal, creatorCap)
  const rounded = Math.floor(raw / 100) * 100
  return rounded >= 100 ? rounded : 0
}
