/**
 * The zero-click rehearsal (server/rehearsal.ts) with the deterministic brains: the whole story —
 * launch, autonomous pledges, releases, purchases, verified reports, votes — completes with no person
 * approving anything.
 */
import { describe, expect, it } from 'vitest'
import { MockBrain } from '../fundraising-agent/brain'
import { MockDonorBrain } from '../donor-agent/brain'
import { runRehearsal } from '../server/rehearsal'

describe('zero-click rehearsal (agents only)', () => {
  it('completes every milestone with no human action', async () => {
    const lines: string[] = []
    const r = await runRehearsal({ fundBrain: new MockBrain(), donorBrain: new MockDonorBrain(), dataSource: 'synthetic', log: l => lines.push(l) })
    expect(r).toMatchObject({ status: 'completed', milestonesReleased: 3, humanActions: 0 })
    expect(r.raised).toBeGreaterThanOrEqual(1_200) // the goal derived from the spending plan (fundraising-agent/campaignPlan.ts)
    expect(r.spent.calls).toBeGreaterThan(0)
    expect(r.donors.every(d => d.pledged > 0)).toBe(true)
    expect(r.donors.some(d => d.votes.some(v => /m2:yes/.test(v)))).toBe(true)
  }, 300_000)
})
