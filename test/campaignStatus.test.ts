import { describe, expect, it } from 'vitest'
import { campaignStatus, type CampaignMeta } from '../core/campaign'

const meta = { goal: 10_000, deadline: 1_000, milestones: [{ title: 'A', percent: 50 }, { title: 'B', percent: 50 }] } as unknown as CampaignMeta

describe('campaign status', () => {
  it('keeps raising below the goal until the deadline, then fails', () => {
    expect(campaignStatus(meta, 9_999, 0, 999)).toBe('active')
    expect(campaignStatus(meta, 9_999, 0, 1_000)).toBe('failed')
  })

  it('is funded as soon as the pot reaches the goal, before or after the deadline', () => {
    expect(campaignStatus(meta, 10_000, 0, 10)).toBe('funded')
    expect(campaignStatus(meta, 12_000, 1, 999)).toBe('funded')
    expect(campaignStatus(meta, 10_000, 0, 2_000)).toBe('funded')
  })

  it('is completed once every milestone is released', () => {
    expect(campaignStatus(meta, 10_000, 2, 10)).toBe('completed')
  })
})
