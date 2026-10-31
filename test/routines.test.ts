import { describe, expect, it } from 'vitest'
import {
  applyRun, canSetStatus, checkRun, describeDraft, isDue, keywordsFor, matchCampaigns, newRoutine, nextRunAfter, ownerKey,
  parseRoutineText, satsFor, validateDraft, type CampaignLike, type RoutineDraft
} from '../core/routines'

const T0 = Date.UTC(2026, 0, 31, 12) / 1000 // 31 Jan 2026, to check month-end handling
const owner = { scheme: 'brc103' as const, identityKey: '02'.padEnd(66, 'a') }

const draft = (over: Partial<RoutineDraft> = {}): RoutineDraft => ({
  text: 'Spende jeden Monat 10 Euro an einen Tierschutzverein',
  amount: { value: 10, currency: 'EUR' },
  interval: 'monthly',
  target: { label: 'Tierschutzverein', keywords: keywordsFor('Tierschutzverein') },
  limits: { maxSatsPerRun: 50_000, maxRuns: null, maxTotalSats: null },
  ...over
})

describe('parseRoutineText', () => {
  it('reads the German example from the brief', () => {
    const r = parseRoutineText('Spende jeden Monat 10 Euro an einen Tierschutzverein.')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.lang).toBe('de')
    expect(r.draft.amount).toEqual({ value: 10, currency: 'EUR' })
    expect(r.draft.interval).toBe('monthly')
    expect(r.draft.target.label).toBe('Tierschutzverein')
    expect(r.draft.target.keywords).toEqual(expect.arrayContaining(['tierschutzverein', 'animal', 'wildlife']))
    expect(r.draft.limits.maxRuns).toBeNull()
  })

  it('reads English, currency symbols and weekly', () => {
    const r = parseRoutineText('donate $5 every week to an animal shelter')
    expect(r).toMatchObject({ ok: true, lang: 'en', draft: { amount: { value: 5, currency: 'USD' }, interval: 'weekly', target: { label: 'animal shelter' } } })
  })

  it('defaults to a one-off gift and reads sats', () => {
    const r = parseRoutineText('Give 5000 sats to river cleanup')
    expect(r).toMatchObject({ ok: true, draft: { amount: { value: 5000, currency: 'SATS' }, interval: 'once', limits: { maxRuns: 1 } } })
  })

  it('reads decimal commas, a run count and BSV amounts', () => {
    expect(parseRoutineText('Spende für 6 Monate monatlich 2,50 € an die Tafel')).toMatchObject({
      ok: true, draft: { amount: { value: 2.5, currency: 'EUR' }, interval: 'monthly', limits: { maxRuns: 6 }, target: { label: 'Tafel' } }
    })
    expect(parseRoutineText('donate 0.001 bsv every year for 3 years to open science research')).toMatchObject({
      ok: true, draft: { amount: { value: 100_000, currency: 'SATS' }, interval: 'yearly', limits: { maxRuns: 3 } }
    })
  })

  it('asks back when the amount or the cause is missing', () => {
    expect(parseRoutineText('spende jeden Monat an Tierschutz')).toMatchObject({ ok: false, lang: 'de' })
    expect(parseRoutineText('donate 10 euros every month')).toMatchObject({ ok: false, error: expect.stringContaining('Who') })
  })

  it('assumes euros for a bare number instead of asking again, and says so', () => {
    expect(parseRoutineText('Give 10 every week to schools')).toMatchObject({
      ok: true, assumedCurrency: true, draft: { amount: { value: 10, currency: 'EUR' }, interval: 'weekly', target: { label: 'schools' } }
    })
    // Run counts are not mistaken for the amount.
    expect(parseRoutineText('donate 5 every month for 6 months to cats')).toMatchObject({
      ok: true, draft: { amount: { value: 5, currency: 'EUR' }, limits: { maxRuns: 6 } }
    })
    expect(parseRoutineText('Donate 10 euros to cats')).not.toHaveProperty('assumedCurrency')
  })

  it.each([
    ['Donate ten euros a month to cats', { value: 10, currency: 'EUR' }, 'cats'],
    ['Spende zwanzig Euro an die Tafel', { value: 20, currency: 'EUR' }, 'Tafel'],
    ['Donate 10.000 sats weekly to education', { value: 10_000, currency: 'SATS' }, 'education'],
    ['donate 1,000,000 sats to research', { value: 1_000_000, currency: 'SATS' }, 'research'],
    ['donate 50 cents to schools', { value: 0.5, currency: 'EUR' }, 'schools'],
    ['Give 5 bucks to schools', { value: 5, currency: 'USD' }, 'schools'],
    ['I want to donate 15€ per month to a dog shelter', { value: 15, currency: 'EUR' }, 'dog shelter']
  ])('reads "%s"', (text, amount, label) => {
    expect(parseRoutineText(text)).toMatchObject({ ok: true, draft: { amount, target: { label } } })
  })

  it('does not turn "one-off" into a number', () => {
    expect(parseRoutineText('a one-off gift of 5 euros to cats')).toMatchObject({ ok: true, draft: { interval: 'once', amount: { value: 5 } } })
  })
})

describe('validateDraft', () => {
  it('accepts a sane draft and normalises it', () => {
    expect(validateDraft(draft({ target: { label: ' Tiere ', keywords: ['ANIMAL'] } })).target).toEqual({ label: 'Tiere', keywords: ['animal'] })
  })

  it.each([
    ['a cap below the minimum pledge', { limits: { maxSatsPerRun: 50, maxRuns: null, maxTotalSats: null } }],
    ['an unknown interval', { interval: 'hourly' as any }],
    ['a one-off with several runs', { interval: 'once' as const, limits: { maxSatsPerRun: 1000, maxRuns: 3, maxTotalSats: null } }],
    ['a sats amount above the cap', { amount: { value: 60_000, currency: 'SATS' as const } }],
    ['no keywords and no campaign', { target: { label: 'x', keywords: [] } }],
    ['a total cap below the per-run cap', { limits: { maxSatsPerRun: 50_000, maxRuns: null, maxTotalSats: 10 } }]
  ])('refuses %s', (_, over) => {
    expect(() => validateDraft(draft(over))).toThrow()
  })
})

describe('schedule and limits', () => {
  it('advances by calendar month, clamping like Date does', () => {
    expect(new Date(nextRunAfter('monthly', T0)! * 1000).toISOString()).toBe('2026-03-03T12:00:00.000Z')
    expect(nextRunAfter('weekly', T0)).toBe(T0 + 7 * 86_400)
    expect(nextRunAfter('once', T0)).toBeNull()
  })

  it('is due at once, then on schedule; enforces the per-run cap', () => {
    let r = newRoutine('r1', owner, draft(), T0)
    expect(isDue(r, T0)).toBe(true)
    expect(() => checkRun(r, 60_000, T0)).toThrow(/cap/)
    checkRun(r, 40_000, T0)
    r = applyRun(r, { at: T0 + 60, campaignId: 'c'.repeat(64), campaignTitle: 'Shelter', sats: 40_000, pledgeId: 'tx.0' })
    expect(r.status).toBe('active')
    expect(isDue(r, T0 + 86_400)).toBe(false)
    expect(() => checkRun(r, 40_000, T0 + 86_400)).toThrow(/not due/)
    expect(isDue(r, r.nextRunAt!)).toBe(true)
  })

  it('completes after maxRuns, after a one-off, and at the total cap', () => {
    const run = { at: T0, campaignId: 'c'.repeat(64), campaignTitle: 'x', sats: 20_000, pledgeId: 'tx.0' }
    expect(applyRun(newRoutine('a', owner, draft({ limits: { maxSatsPerRun: 50_000, maxRuns: 1, maxTotalSats: null } }), T0), run)).toMatchObject({ status: 'completed', nextRunAt: null })
    expect(applyRun(newRoutine('b', owner, draft({ interval: 'once', limits: { maxSatsPerRun: 50_000, maxRuns: 1, maxTotalSats: null } }), T0), run).status).toBe('completed')
    const capped = newRoutine('c', owner, draft({ limits: { maxSatsPerRun: 50_000, maxRuns: null, maxTotalSats: 60_000 } }), T0)
    const once = applyRun(capped, run)
    expect(once.status).toBe('active')
    expect(() => checkRun({ ...once, nextRunAt: T0 }, 50_000, T0)).toThrow(/total cap/)
  })

  it('pauses, resumes and keeps final states final', () => {
    expect(canSetStatus('active', 'paused')).toBe(true)
    expect(canSetStatus('paused', 'active')).toBe(true)
    expect(canSetStatus('cancelled', 'active')).toBe(false)
    expect(canSetStatus('completed', 'paused')).toBe(false)
    expect(() => checkRun({ ...newRoutine('p', owner, draft(), T0), status: 'paused' }, 1000, T0)).toThrow(/paused/)
  })

  it('converts fiat at the given rate and refuses without one', () => {
    expect(satsFor({ value: 10, currency: 'EUR' }, 40)).toBe(25_000_000)
    expect(satsFor({ value: 777, currency: 'SATS' })).toBe(777)
    expect(() => satsFor({ value: 10, currency: 'USD' })).toThrow(/exchange rate/)
  })
})

describe('matchCampaigns', () => {
  const c = (id: string, title: string, description: string, status: CampaignLike['status'] = 'active', deadline = T0 + 1000): CampaignLike =>
    ({ id: id.repeat(64), meta: { title, description, deadline }, status })
  const campaigns = [
    c('a', 'Track 12 elephants through the drought', 'Wildlife trust collars'),
    c('b', 'Air quality reports', 'Buys AQI data'),
    c('c', 'Dog shelter roof', 'Animal shelter needs a roof', 'funded'),
    c('d', 'Old animal campaign', 'animal', 'active', T0 - 1)
  ]

  it('finds open campaigns by topic synonyms, best first', () => {
    const m = matchCampaigns({ label: 'Tierschutzverein', keywords: keywordsFor('Tierschutzverein') }, campaigns, T0)
    expect(m.map(x => x.campaign.id[0])).toEqual(['a'])
  })

  it('uses only the pinned campaign when one is set', () => {
    expect(matchCampaigns({ label: 'x', keywords: ['animal'], campaignId: 'b'.repeat(64) }, campaigns, T0).map(x => x.campaign.id[0])).toEqual(['b'])
  })
})

it('owner keys are scheme-prefixed, so a ZK owner can never collide with a BRC-103 one', () => {
  expect(ownerKey(owner)).toBe(`brc103:${owner.identityKey}`)
  expect(ownerKey({ scheme: 'zk', commitment: 'abc' })).toBe('zk:abc')
})

it('describes a draft in the user\'s language', () => {
  expect(describeDraft(draft(), 'de')).toBe('Verstanden: 10 € jeden Monat an „Tierschutzverein“.')
  expect(describeDraft(draft({ limits: { maxSatsPerRun: 50_000, maxRuns: 3, maxTotalSats: null } }), 'en')).toBe('Got it: 10 € every month, 3 times to "Tierschutzverein".')
})
