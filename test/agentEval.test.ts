/** The eval harness, run with the deterministic brains: every invariant and quality case should pass. */
import { describe, expect, it } from 'vitest'
import { MockBrain } from '../fundraising-agent/brain'
import { MockDonorBrain, type DonorBrain } from '../donor-agent/brain'
import { runAgentEval, toMarkdown } from '../eval/agentEval'

describe('agent eval harness', () => {
  it('with the deterministic brains, everything passes and the report says so', async () => {
    const r = await runAgentEval(new MockDonorBrain(), new MockBrain())
    expect(r.filter(x => !x.pass)).toEqual([])
    expect(r.filter(x => x.kind === 'invariant').length).toBeGreaterThanOrEqual(8)
    expect(toMarkdown([r, r], 'mock')).toMatch(/Every invariant held in every run/)
  })
  it('a brain that scores everything 100 is still held to the invariants by the code rules', async () => {
    const gullible: DonorBrain = { name: 'gullible', assessCampaign: async () => ({ fit: 100, milestoneQuality: 100, riskFlags: [], summary: 'great' }), assessReport: async () => ({ verdict: 'approve', reasons: [] }) }
    const r = await runAgentEval(gullible, new MockBrain())
    expect(r.filter(x => x.name.startsWith('manipulation') && !x.pass)).toEqual([]) // code rule catches all four
    expect(r.find(x => x.name === 'a report with no evidence is never approved')?.pass).toBe(false) // a brain-only invariant: the eval reports it
  })
})
