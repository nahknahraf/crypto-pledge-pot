/** Payment-plan compliance: the state machine (report date, grace period, cure, repayment, breach) and pro-rata repayment shares. */
import { describe, expect, it } from 'vitest'
import { P2PKH, PrivateKey } from '@bsv/sdk'
import { milestoneCompliance, repaymentShares, type Contribution, type Repaid } from '../core/compliance'
import { defaultLegalTerms, type PaymentPlan, type VerifiedSpend } from '../core/paymentPlan'

const DAY = 86_400
const vendor = new P2PKH().lock(PrivateKey.fromRandom().toAddress()).toHex()
const plan: PaymentPlan = {
  v: 1, tolerancePercent: 10, reportDays: 30, graceDays: 7, legalTerms: defaultLegalTerms(),
  milestones: [{ lines: [{ id: 'a', category: 'Filters', percent: 60, payee: { kind: 'onchain', name: 'V', lockingScript: vendor } }, { id: 'b', category: 'Pumps', percent: 40, payee: { kind: 'onchain', name: 'V', lockingScript: vendor } }] }]
}
const T = 1_800_000_000
const contributions: Contribution[] = [{ pledgeId: 'p1', donorKey: '', sats: 6_000 }, { pledgeId: 'p2', donorKey: '', sats: 4_000 }]
const spent = (lineId: string, sats: number, at: number): VerifiedSpend & { at: number } => ({ lineId, verifiedSats: sats, ok: true, reason: '', at })
const state = (spends: Array<VerifiedSpend & { at: number }>, now: number, repaid: Repaid[] = []) =>
  milestoneCompliance({ plan, milestone: 1, releasedSats: 10_000, releasedAt: T, spends, contributions, repaid, now })

describe('repayment shares', () => {
  it('are pro rata and add up exactly', () => {
    expect([...repaymentShares(1_000, contributions)]).toEqual([['p1', 600], ['p2', 400]])
    const odd = repaymentShares(1_001, [{ pledgeId: 'x', donorKey: '', sats: 1 }, { pledgeId: 'y', donorKey: '', sats: 1 }, { pledgeId: 'z', donorKey: '', sats: 1 }])
    expect([...odd.values()].reduce((a, b) => a + b)).toBe(1_001)
  })
})

describe('the compliance timeline', () => {
  const full = [spent('a', 6_000, T + DAY), spent('b', 4_200, T + 2 * DAY)]

  it('compliant as soon as every line is within tolerance, even before the report date', () => {
    expect(state(full, T + 3 * DAY)).toMatchObject({ state: 'compliant', dueBackSats: 0 })
  })

  it('reporting until the report date, then a 7-day grace period', () => {
    const partial = [spent('a', 6_000, T + DAY)]
    expect(state(partial, T + 29 * DAY)).toMatchObject({ state: 'reporting', reportDueAt: T + 30 * DAY })
    const g = state(partial, T + 31 * DAY)
    expect(g).toMatchObject({ state: 'grace', dueBackSats: 4_000, graceEndsAt: T + 37 * DAY })
    expect(g.detail).toMatch(/pay back 4,000 sats/)
  })

  it('cured when the missing line is reported during the grace period', () => {
    expect(state([spent('a', 6_000, T + DAY), spent('b', 4_000, T + 33 * DAY)], T + 34 * DAY)).toMatchObject({ state: 'cured', dueBackSats: 0 })
  })

  it('a report after the grace period comes too late', () => {
    expect(state([spent('a', 6_000, T + DAY), spent('b', 4_000, T + 38 * DAY)], T + 39 * DAY).state).toBe('breached')
  })

  it('repaid when every donor got their share of the unaccounted sats in time', () => {
    const partial = [spent('a', 6_000, T + DAY)]
    const half: Repaid[] = [{ pledgeId: 'p1', sats: 2_400, at: T + 32 * DAY }]
    expect(state(partial, T + 33 * DAY, half)).toMatchObject({ state: 'grace', repaidSats: 2_400 })
    expect(state(partial, T + 33 * DAY, [...half, { pledgeId: 'p2', sats: 1_600, at: T + 33 * DAY }])).toMatchObject({ state: 'repaid', repaidSats: 4_000 })
  })

  it('paying one donor everything does not count for the others', () => {
    expect(state([spent('a', 6_000, T + DAY)], T + 40 * DAY, [{ pledgeId: 'p1', sats: 4_000, at: T + 32 * DAY }])).toMatchObject({ state: 'breached', repaidSats: 2_400 })
  })

  it('breached when nothing happens by the end of the grace period', () => {
    const b = state([], T + 37 * DAY)
    expect(b).toMatchObject({ state: 'breached', dueBackSats: 10_000, repaidSats: 0 })
  })
})
