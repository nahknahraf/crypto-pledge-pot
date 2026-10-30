/** NGO payment plan: validation, the tolerance maths, and the signatures that bind the NGO and the auditor. */
import { describe, expect, it } from 'vitest'
import { P2PKH, PrivateKey, ProtoWallet, Utils } from '@bsv/sdk'
import {
  AUDIT_PROTOCOL,
  auditMessage,
  defaultLegalTerms,
  evaluateSpending,
  PAYMENT_PLAN_PROTOCOL,
  paymentPlanHash,
  plannedSats,
  validatePaymentPlan,
  verifyAuditAttestation,
  verifyPaymentPlanSignature,
  verifySpendClaim,
  type PaymentPlan,
  type VerifiedSpend
} from '../core/paymentPlan'

const vendor = new P2PKH().lock(PrivateKey.fromRandom().toAddress()).toHex()
const auditor = PrivateKey.fromRandom()
const plan = (over: Partial<PaymentPlan> = {}): PaymentPlan => ({
  v: 1,
  tolerancePercent: 10,
  reportDays: 30,
  graceDays: 7,
  auditorKey: auditor.toPublicKey().toString(),
  legalTerms: defaultLegalTerms(),
  milestones: [
    { lines: [{ id: 'm1-filters', category: 'Water filters', percent: 60, payee: { kind: 'onchain', name: 'AquaPure Ltd', lockingScript: vendor } }, { id: 'm1-staff', category: 'Field staff', percent: 40, payee: { kind: 'offchain', name: 'Local staff payroll' } }] },
    { lines: [{ id: 'm2-install', category: 'Installation', percent: 100, payee: { kind: 'onchain', name: 'AquaPure Ltd', lockingScript: vendor } }] }
  ],
  ...over
})
const spend = (lineId: string, verifiedSats: number): VerifiedSpend => ({ lineId, verifiedSats, ok: true, reason: '' })

describe('validation', () => {
  it('accepts a sound plan', () => { expect(() => validatePaymentPlan(plan(), 2)).not.toThrow() })

  it.each<[string, Partial<PaymentPlan>, number, RegExp]>([
    ['wrong milestone count', {}, 3, /one budget per milestone \(3\)/],
    ['tolerance above 25%', { tolerancePercent: 30 }, 2, /tolerancePercent/],
    ['lines not adding to 100%', { milestones: [{ lines: [{ id: 'a', category: 'x', percent: 50, payee: { kind: 'onchain', name: 'v', lockingScript: vendor } }] }, plan().milestones[1]] }, 2, /add up to 100% \(got 50%\)/],
    ['off-chain payee without an auditor', { auditorKey: undefined }, 2, /must name an auditorKey/],
    ['duplicate line id', { milestones: [plan().milestones[0], { lines: [{ ...plan().milestones[0].lines[0], percent: 100 }] }] }, 2, /used twice/]
  ])('rejects %s', (_name, over, count, error) => {
    expect(() => validatePaymentPlan(plan(over), count)).toThrow(error)
  })
})

describe('the tolerance maths', () => {
  it('splits a tranche into planned amounts that add up exactly', () => {
    const p = plannedSats(plan(), 1, 1001)
    expect([...p.values()]).toEqual([601, 400])
    expect([...p.values()].reduce((a, b) => a + b)).toBe(1001)
  })

  it('spending within 10% of every line is compliant, with nothing to pay back', () => {
    const r = evaluateSpending(plan(), 1, 10_000, [spend('m1-filters', 6_500), spend('m1-staff', 3_700)])
    expect(r.lines.map(l => [l.deviationPercent, l.withinTolerance])).toEqual([[8.3, true], [7.5, true]])
    expect(r).toMatchObject({ ok: true, unaccountedSats: 0 })
  })

  it('exactly 10% off is still within tolerance; just over is not', () => {
    expect(evaluateSpending(plan(), 1, 10_000, [spend('m1-filters', 6_600), spend('m1-staff', 4_000)]).ok).toBe(true)
    expect(evaluateSpending(plan(), 1, 10_000, [spend('m1-filters', 6_601), spend('m1-staff', 4_000)]).ok).toBe(false)
  })

  it('a missing line makes the milestone non-compliant and that money unaccounted', () => {
    const r = evaluateSpending(plan(), 1, 10_000, [spend('m1-filters', 6_000)])
    expect(r).toMatchObject({ ok: false, compliantSats: 6_000, unaccountedSats: 4_000 })
    expect(r.lines[1]).toMatchObject({ lineId: 'm1-staff', spentSats: 0, deviationPercent: 100, withinTolerance: false })
  })

  it('overspending one line only counts up to planned + 10%; the excess is unaccounted', () => {
    const r = evaluateSpending(plan(), 1, 10_000, [spend('m1-filters', 9_000), spend('m1-staff', 1_000)])
    expect(r).toMatchObject({ ok: false, compliantSats: 6_600 + 1_000, unaccountedSats: 2_400 })
  })

  it('claims that failed verification count for nothing', () => {
    const r = evaluateSpending(plan(), 1, 10_000, [{ lineId: 'm1-filters', verifiedSats: 6_000, ok: false, reason: 'wrong payee' }, spend('m1-staff', 4_000)])
    expect(r.lines[0].spentSats).toBe(0)
  })
})

describe('signatures', () => {
  it('anyone can verify the NGO\'s signature over the plan; a changed plan fails', async () => {
    const ngo = new ProtoWallet(PrivateKey.fromRandom())
    const identityKey = (await ngo.getPublicKey({ identityKey: true })).publicKey
    const nonce = '00112233445566778899aabbccddeeff'
    const { signature } = await ngo.createSignature({ hashToDirectlySign: paymentPlanHash(plan()), protocolID: PAYMENT_PLAN_PROTOCOL, keyID: nonce, counterparty: 'anyone' })
    const sig = Utils.toHex(signature)
    expect(await verifyPaymentPlanSignature(plan(), sig, identityKey, nonce)).toBe(true)
    expect(await verifyPaymentPlanSignature(plan({ tolerancePercent: 25 }), sig, identityKey, nonce)).toBe(false)
    expect(await verifyPaymentPlanSignature(plan(), sig, identityKey, 'ffeeddccbbaa99887766554433221100')).toBe(false)
  })

  it('an off-chain invoice counts only with the named auditor\'s signature', async () => {
    const campaignId = 'ab'.repeat(32)
    const invoiceSha256 = 'cd'.repeat(32)
    const sign = async (key: PrivateKey, sats: number): Promise<string> => Utils.toHex((await new ProtoWallet(key).createSignature({
      data: Utils.toArray(auditMessage(campaignId, 1, 'm1-staff', sats, invoiceSha256), 'utf8'), protocolID: AUDIT_PROTOCOL, keyID: campaignId, counterparty: 'anyone'
    })).signature)
    const good = { lineId: 'm1-staff', sats: 4_000, invoiceSha256, attestation: await sign(auditor, 4_000) }
    expect(await verifyAuditAttestation(auditor.toPublicKey().toString(), campaignId, 1, good)).toBe(true)
    expect(await verifySpendClaim(plan(), campaignId, 1, good)).toMatchObject({ ok: true, verifiedSats: 4_000 })
    // The NGO raising the amount after the auditor signed, or signing itself, does not work.
    expect((await verifySpendClaim(plan(), campaignId, 1, { ...good, sats: 9_000 })).ok).toBe(false)
    expect((await verifySpendClaim(plan(), campaignId, 1, { ...good, attestation: await sign(PrivateKey.fromRandom(), 4_000) })).reason).toMatch(/not signed by the plan's auditor/)
  })

  it('an on-chain payment must go to the line\'s payee', async () => {
    expect(await verifySpendClaim(plan(), 'ab'.repeat(32), 1, { lineId: 'm1-filters' }, { satoshis: 6_000, lockingScript: vendor })).toMatchObject({ ok: true, verifiedSats: 6_000 })
    const elsewhere = new P2PKH().lock(PrivateKey.fromRandom().toAddress()).toHex()
    expect((await verifySpendClaim(plan(), 'ab'.repeat(32), 1, { lineId: 'm1-filters' }, { satoshis: 6_000, lockingScript: elsewhere })).reason).toMatch(/does not go to AquaPure Ltd/)
  })
})
