/** The zero-click run's plan (scripts/zeroClick.ts): valid autopilot mandates, consistent amounts, the owner's files kept. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseMandate } from '../donor-agent/mandate'
import { MIN_PLEDGE } from '../core/pledge'
import { depositNeeded, ensureDonorMandate, fundTargets, totalFunding, ZERO_CLICK } from '../scripts/zeroClick'
import { planCampaign } from '../fundraising-agent/campaignPlan'

describe('zero-click plan', () => {
  it('writes a valid autopilot mandate per donor agent, and never overwrites one the owner wrote', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zc-'))
    for (const d of ZERO_CLICK.donors) {
      const m = parseMandate(JSON.parse(fs.readFileSync(ensureDonorMandate(d, root), 'utf8')))
      expect(m).toMatchObject({ mode: 'autopilot', scoreThreshold: 60 })
    }
    const f = ensureDonorMandate(ZERO_CLICK.donors[0], root)
    fs.writeFileSync(f, '{"owner":"edited"}')
    ensureDonorMandate(ZERO_CLICK.donors[0], root)
    expect(fs.readFileSync(f, 'utf8')).toBe('{"owner":"edited"}')
    fs.rmSync(root, { recursive: true })
  })
  it('funds each donor agent above its budget, and asks for a deposit that covers everything plus fees', () => {
    expect(ZERO_CLICK.donorFunding).toBeGreaterThan(ZERO_CLICK.donorBudget.totalSats) // budget plus its own fees
    expect(ZERO_CLICK.donorBudget.perPledgeMaxSats / 2).toBeGreaterThanOrEqual(MIN_PLEDGE)
    expect(ZERO_CLICK.agentFunding).toBeGreaterThan(ZERO_CLICK.agentFeeReserve)
    expect(totalFunding()).toBe(fundTargets().reduce((s, t) => s + t.sats, 0))
    expect(depositNeeded()).toBeGreaterThan(totalFunding())
    expect(new Set(fundTargets().map(t => t.fundUrl)).size).toBe(fundTargets().length) // every agent on its own port
  })
  it('the goal is reachable if any 2 of the 3 donor agents say yes at a passing score (mainnet run 1 needed all 3)', () => {
    const goal = planCampaign({ readingsPerMilestone: 5, pricePerReading: 50, feeAllowancePerMilestone: 150 }).goal
    const atPassingScore = Math.floor(ZERO_CLICK.donorBudget.perPledgeMaxSats * 0.5 / 100) * 100 // screen.ts amountFor, score 60–74
    expect(2 * atPassingScore).toBeGreaterThanOrEqual(goal)
  })
})
