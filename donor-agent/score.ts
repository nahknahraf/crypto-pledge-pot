/**
 * The 0–100 score with its reasons: code features plus the brain's judgement.
 *   fit 35 · milestone quality 25 · creator record 20 · campaign health 10 · base 10 · risk flags −5 each (max −15; owner decision 2026-10-31: concerns count, but no longer veto every new creator)
 */
import type { CampaignView } from '../core/api'
import { MANIPULATION, type CampaignAssessment } from './brain'
import type { CreatorRecord } from './screen'

export interface Score { total: number, parts: Array<{ name: string, points: number, max: number, why: string }> }

export function scoreCampaign (c: CampaignView, a: CampaignAssessment, record: CreatorRecord, now: number): Score {
  const parts: Score['parts'] = []
  parts.push({ name: 'fit with your interests', points: Math.round(a.fit * 0.35), max: 35, why: a.summary })
  parts.push({ name: 'measurable milestones', points: Math.round(a.milestoneQuality * 0.25), max: 25, why: `${a.milestoneQuality}/100` })
  const delivered = record.completed + record.failed === 0 ? 0.5 : record.completed / (record.completed + record.failed)
  parts.push({ name: 'creator record', points: Math.round(20 * delivered), max: 20, why: `${record.completed} completed, ${record.failed} failed` })
  const funded = c.meta.goal > 0 ? Math.min(1, c.raised / c.meta.goal) : 0
  const timeLeft = Math.max(0, Math.min(1, (c.meta.deadline - now) / (c.meta.deadline - c.meta.createdAt || 1)))
  parts.push({ name: 'campaign health', points: Math.round(10 * Math.min(1, funded + timeLeft * 0.5 + Math.min(c.donors, 5) / 10)), max: 10, why: `${Math.round(funded * 100)}% funded, ${c.donors} backer(s)` })
  parts.push({ name: 'base', points: 10, max: 10, why: 'passed every hard rule' })
  if (a.riskFlags.length > 0) parts.push({ name: 'risk flags', points: -Math.min(15, a.riskFlags.length * 5), max: 0, why: a.riskFlags.join('; ') })
  // Trying to steer AI agents is disqualifying, not just a deduction.
  const manipulation = a.riskFlags.filter(f => f.startsWith(MANIPULATION))
  if (manipulation.length > 0) return { total: 0, parts: [...parts, { name: 'disqualified', points: -100, max: 0, why: manipulation.join('; ') }] }
  const total = Math.max(0, Math.min(100, parts.reduce((s, p) => s + p.points, 0)))
  return { total, parts }
}
