/** validateCampaign: one valid campaign, then one field broken at a time. */
import { describe, expect, it } from 'vitest'
import { PrivateKey } from '@bsv/sdk'
import { LIMITS, validateCampaign, type CampaignMeta } from '../core/campaign'
import { MAX_MILESTONES } from '../core/pledge'

const key = (): string => PrivateKey.fromRandom().toPublicKey().toString()
const T = 1_800_000_000
const base = (): CampaignMeta => ({
  v: 1, title: 'Water well', description: 'One borehole.', goal: 5_000, deadline: T, refundAfter: T + 86_400,
  milestones: [{ title: 'Drill', percent: 60 }, { title: 'Test', percent: 40 }],
  creatorIdentityKey: key(), creatorKey: key(), arbiterKey: key(), nonce: '0'.repeat(32), createdAt: T - 100
})
const bad = (over: Partial<CampaignMeta>): () => void => () => { validateCampaign({ ...base(), ...over }) }

describe('validateCampaign', () => {
  it('accepts a sensible campaign, a single 100 % milestone, the maximum milestone count, unicode and an agent URL', () => {
    expect(bad({})).not.toThrow()
    expect(bad({ milestones: [{ title: 'All of it', percent: 100 }] })).not.toThrow()
    expect(bad({ milestones: Array.from({ length: MAX_MILESTONES }, (_, i) => ({ title: `M${i + 1}`, percent: 100 / MAX_MILESTONES })) })).not.toThrow()
    expect(bad({ title: 'Brunnen für Kitui 💧', description: 'Ü'.repeat(LIMITS.description) })).not.toThrow()
    expect(bad({ kind: 'agent', agentUrl: 'https://agent.example.org/status', agentLimits: { pricePerCallSats: 50, maxSpendPerMilestoneSats: 250 } })).not.toThrow()
  })

  const cases: Array<[string, Partial<CampaignMeta>, RegExp]> = [
    ['empty title', { title: '   ' }, /title/],
    ['title too long', { title: 'x'.repeat(LIMITS.title + 1) }, /title/],
    ['description too long', { description: 'x'.repeat(LIMITS.description + 1) }, /description/],
    ['goal 0', { goal: 0 }, /goal/],
    ['fractional goal', { goal: 10.5 }, /goal/],
    ['deadline in block heights', { deadline: 900_000 }, /deadline/],
    ['refundAfter equal to the deadline', { refundAfter: T }, /refundAfter/],
    ['refundAfter beyond nLockTime range', { refundAfter: 0x1_0000_0000 }, /refundAfter/],
    ['no milestones', { milestones: [] }, /milestones/],
    ['too many milestones', { milestones: Array.from({ length: MAX_MILESTONES + 1 }, (_, i) => ({ title: `M${i}`, percent: 20 })) }, /milestones/],
    ['percentages not adding to 100', { milestones: [{ title: 'A', percent: 60 }, { title: 'B', percent: 30 }] }, /./],
    ['untitled milestone', { milestones: [{ title: '', percent: 100 }] }, /title/],
    ['bad key', { arbiterKey: '02abc' }, /keys/],
    ['bad nonce', { nonce: 'xyz' }, /nonce/],
    ['unknown kind', { kind: 'robot' as 'agent' }, /kind/],
    ['javascript: agent URL', { agentUrl: 'javascript:alert(1)' }, /agentUrl/],
    ['agent URL with spaces', { agentUrl: 'https://a b' }, /agentUrl/],
    ['http image URL', { imageUrl: 'http://x.org/a.png' }, /imageUrl/],
    ['agent limits with a 0 price', { agentLimits: { pricePerCallSats: 0, maxSpendPerMilestoneSats: 10 } }, /agentLimits/],
    ['milestone limit below one call', { agentLimits: { pricePerCallSats: 50, maxSpendPerMilestoneSats: 49 } }, /agentLimits/]
  ]
  it.each(cases)('refuses %s', (_name, over, why) => { expect(bad(over)).toThrow(why) })
})
