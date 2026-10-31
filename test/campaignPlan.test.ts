/**
 * The fundraising agent's terms come from one spending plan, so they can't contradict each other
 * (the contradictions real Claude found in the hand-written terms: goal ≫ spending cap; 10 cities under a 5-reading cap).
 */
import { describe, expect, it } from 'vitest'
import { planCampaign } from '../fundraising-agent/campaignPlan'
import { LIMITS } from '../core/campaign'

describe('campaign terms from one spending plan', () => {
  const t = planCampaign({ readingsPerMilestone: 5, pricePerReading: 50, feeAllowancePerMilestone: 150, operator: 'Team X' })
  it('goal = 3 × (data + fees); the cap = one milestone of data; the percents add to 100', () => {
    expect(t).toMatchObject({ goal: 1_200, maxSpendPerMilestone: 250 })
    expect(t.milestones.reduce((s, m) => s + m.percent, 0)).toBe(100)
  })
  it('every milestone fits the cap: no milestone promises more readings than the cap buys', () => {
    const readingsPerMilestone = t.maxSpendPerMilestone / 50
    for (const m of t.milestones) {
      const promised = Number(m.title.match(/(\d+) (?:more |worst )?cities/)?.[1])
      expect(promised).toBeLessThanOrEqual(readingsPerMilestone)
      expect(m.title.length).toBeLessThanOrEqual(LIMITS.milestoneTitle) // the platform's limit
      expect(Math.round(t.goal * m.percent / 100)).toBeGreaterThanOrEqual(t.maxSpendPerMilestone) // each tranche covers its data
    }
  })
  it('the description states the same numbers, the data source plainly, and the operator', () => {
    expect(t.description).toMatch(/5 readings × 50 sats = 250 sats of data, plus up to 150 sats of network fees: 400 sats per milestone, 1,200 sats in total/)
    expect(t.description).toMatch(/resells Open-Meteo \(CAMS\) readings/)
    expect(t.description).toMatch(/Operated by: Team X\./)
    expect(planCampaign({ readingsPerMilestone: 5, pricePerReading: 50, feeAllowancePerMilestone: 150 }).description).not.toMatch(/Operated by/)
  })
  it('refuses nonsense', () => {
    expect(() => planCampaign({ readingsPerMilestone: 0, pricePerReading: 50, feeAllowancePerMilestone: 0 })).toThrow(/readingsPerMilestone/)
    expect(() => planCampaign({ readingsPerMilestone: 5, pricePerReading: 1.5, feeAllowancePerMilestone: 0 })).toThrow(/pricePerReading/)
  })
})
