/**
 * NGO payment plan: how the money of every milestone will be spent.
 *
 * The NGO writes the plan BEFORE the campaign starts: for each milestone, the
 * budget lines (what, for whom, what share of that milestone's money) plus the
 * rules it accepts: the tolerance (default 10%), the time to spend and report
 * after a release (default 30 days) and the grace period to fix a breach or
 * pay the money back (default 7 days). The NGO signs the plan with its wallet
 * and the plan is part of the campaign JSON, so its hash is in the campaign id,
 * in the on-chain anchor and in every donor's escrow: nobody can change it
 * after the first pledge.
 *
 * Budget lines are shares of the milestone's tranche, not fixed amounts: the
 * campaign may raise more than its goal, and the plan scales with it.
 *
 * Payees:
 *  - onchain:  paid in BSV to a fixed locking script (the vendor's address).
 *              Verified by SPV: the payment output must pay exactly that script.
 *  - offchain: paid in fiat. The NGO submits the invoice's sha256 and a
 *              signature by the plan's named auditor over that invoice.
 *
 * Everything here is pure and deterministic: the arbiter, the compliance
 * agent and any donor compute the same result from the same data.
 */
import { Hash, ProtoWallet, Utils, type WalletProtocol } from '@bsv/sdk'

export const PAYMENT_PLAN_PROTOCOL: WalletProtocol = [1, 'cryptopledgepot payment plan']
export const AUDIT_PROTOCOL: WalletProtocol = [1, 'cryptopledgepot audit']

export const PLAN_DEFAULTS = { tolerancePercent: 10, reportDays: 30, graceDays: 7 } as const
export const PLAN_LIMITS = { linesPerMilestone: 10, category: 60, description: 200, payeeName: 60, legalTerms: 4000, note: 280 } as const

export type Payee =
  | { kind: 'onchain', name: string, /** hex locking script the vendor must be paid to */ lockingScript: string }
  | { kind: 'offchain', name: string }

export interface PlanLine {
  /** Short id, unique within the plan, e.g. "m1-filters". */
  id: string
  category: string
  description?: string
  /** Share of this milestone's released satoshis (whole percent; a milestone's lines sum to 100). */
  percent: number
  payee: Payee
}

export interface MilestonePlan { lines: PlanLine[] }

export interface PaymentPlan {
  v: 1
  /** One entry per campaign milestone, same order. */
  milestones: MilestonePlan[]
  /** Allowed deviation per budget line, in percent of the planned amount (0–25). */
  tolerancePercent: number
  /** Days after a release to spend the money and report every line. */
  reportDays: number
  /** Days to fix a breach (missing proof, deviation) or pay the money back. */
  graceDays: number
  /** Identity key of the auditor whose signature makes an off-chain invoice count. */
  auditorKey?: string
  /** The binding terms the NGO accepts by signing (purpose-bound donation). */
  legalTerms: string
}

const isKey = (k: unknown): boolean => typeof k === 'string' && /^0[23][0-9a-f]{64}$/.test(k)
const isInt = (n: unknown, min: number, max: number): boolean => Number.isSafeInteger(n) && (n as number) >= min && (n as number) <= max

/**
 * Default terms: a purpose-bound donation with a condition (German civil law:
 * Schenkung unter Auflage, §§ 525, 527 BGB), the tolerance, the proof duty and
 * the obligation to return misused money. Shown to donors and signed by the NGO.
 */
export function defaultLegalTerms (tolerancePercent: number = PLAN_DEFAULTS.tolerancePercent, reportDays: number = PLAN_DEFAULTS.reportDays, graceDays: number = PLAN_DEFAULTS.graceDays): string {
  return [
    'Purpose-bound donation under condition (§§ 525, 527 BGB).',
    `1. Purpose: the NGO spends each released milestone only on the budget lines of this payment plan, paid to the named payees.`,
    `2. Tolerance: each budget line may deviate from its planned amount by at most ${tolerancePercent}%.`,
    `3. Proof: within ${reportDays} days of each release the NGO reports every line, with the on-chain payment or the invoice hash signed by the named auditor.`,
    `4. Grace period: if a line is missing or deviates by more than ${tolerancePercent}%, the NGO has ${graceDays} days to fix it or to pay the unaccounted amount back to the donors, pro rata.`,
    `5. Breach: after the grace period the remaining escrow is refunded to the donors, the breach is recorded publicly, and the donors may reclaim misused funds (§ 527 BGB with §§ 812 ff. BGB).`
  ].join('\n')
}

/** Throws with a readable message if `plan` is not a valid plan for `milestoneCount` milestones. */
export function validatePaymentPlan (plan: PaymentPlan, milestoneCount: number): void {
  const fail = (m: string): never => { throw new Error(`invalid payment plan: ${m}`) }
  if (plan === null || typeof plan !== 'object' || plan.v !== 1) fail('unsupported version')
  if (!isInt(plan.tolerancePercent, 0, 25)) fail('tolerancePercent must be 0–25')
  if (!isInt(plan.reportDays, 1, 365)) fail('reportDays must be 1–365')
  if (!isInt(plan.graceDays, 1, 30)) fail('graceDays must be 1–30')
  if (plan.auditorKey !== undefined && !isKey(plan.auditorKey)) fail('auditorKey must be a compressed public key')
  if (typeof plan.legalTerms !== 'string' || plan.legalTerms.trim() === '' || plan.legalTerms.length > PLAN_LIMITS.legalTerms) fail(`legalTerms must be 1–${PLAN_LIMITS.legalTerms} characters`)
  if (!Array.isArray(plan.milestones) || plan.milestones.length !== milestoneCount) fail(`one budget per milestone (${milestoneCount})`)
  const ids = new Set<string>()
  plan.milestones.forEach((m, i) => {
    const where = `milestone ${i + 1}`
    if (!Array.isArray(m?.lines) || m.lines.length < 1 || m.lines.length > PLAN_LIMITS.linesPerMilestone) fail(`${where}: 1 to ${PLAN_LIMITS.linesPerMilestone} budget lines`)
    let total = 0
    for (const l of m.lines) {
      if (typeof l.id !== 'string' || !/^[a-z0-9-]{1,32}$/.test(l.id)) fail(`${where}: line ids are 1–32 characters a-z, 0-9, -`)
      if (ids.has(l.id)) fail(`line id "${l.id}" is used twice`)
      ids.add(l.id)
      if (typeof l.category !== 'string' || l.category.trim() === '' || l.category.length > PLAN_LIMITS.category) fail(`${where}: every line needs a category`)
      if (l.description !== undefined && (typeof l.description !== 'string' || l.description.length > PLAN_LIMITS.description)) fail(`${where}: description too long`)
      if (!isInt(l.percent, 1, 100)) fail(`${where}: line "${l.id}" needs a whole percent 1–100`)
      total += l.percent
      const p = l.payee
      if (p === null || typeof p !== 'object' || typeof p.name !== 'string' || p.name.trim() === '' || p.name.length > PLAN_LIMITS.payeeName) fail(`${where}: line "${l.id}" needs a named payee`)
      if (p.kind === 'onchain') {
        if (typeof p.lockingScript !== 'string' || !/^([0-9a-f]{2}){1,200}$/.test(p.lockingScript)) fail(`${where}: line "${l.id}" needs the payee's locking script (hex)`)
      } else if (p.kind === 'offchain') {
        if (plan.auditorKey === undefined) fail(`${where}: line "${l.id}" is paid off chain, so the plan must name an auditorKey`)
      } else {
        fail(`${where}: payee kind must be onchain or offchain`)
      }
    }
    if (total !== 100) fail(`${where}: budget lines must add up to 100% (got ${total}%)`)
  })
}

/** Canonical JSON (sorted keys): the form that is hashed and signed. Same rule as campaign JSON. */
function canonical (value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export const paymentPlanHash = (plan: PaymentPlan): number[] => Hash.sha256(canonical(plan), 'utf8')

/** Anyone can check the NGO's signature over the plan (BRC-42 key, counterparty 'anyone', keyID = campaign nonce). */
export async function verifyPaymentPlanSignature (plan: PaymentPlan, signatureHex: string, creatorIdentityKey: string, nonce: string): Promise<boolean> {
  try {
    const { valid } = await new ProtoWallet('anyone').verifySignature({
      hashToDirectlyVerify: paymentPlanHash(plan),
      signature: Utils.toArray(signatureHex, 'hex'),
      protocolID: PAYMENT_PLAN_PROTOCOL,
      keyID: nonce,
      counterparty: creatorIdentityKey
    })
    return valid
  } catch {
    return false
  }
}

// ── spending: what the NGO reports, and how it is judged ───────────────────

/** One reported expense against a budget line. */
export interface SpendClaim {
  lineId: string
  /** On-chain payee: the payment output. */
  txid?: string
  vout?: number
  /** Off-chain payee: the invoice amount in satoshis, its sha256 and the auditor's signature over it. */
  sats?: number
  invoiceSha256?: string
  attestation?: string
  note?: string
}

/** A claim after verification: only `verifiedSats` count. */
export interface VerifiedSpend { lineId: string, verifiedSats: number, ok: boolean, reason: string }

/** The message the auditor signs to vouch for an off-chain invoice. */
export const auditMessage = (campaignId: string, milestone: number, lineId: string, sats: number, invoiceSha256: string): string =>
  `cryptopledgepot audit ${campaignId} milestone ${milestone} line ${lineId} sats ${sats} invoice ${invoiceSha256}`

/** Check the auditor's signature over an off-chain invoice. */
export async function verifyAuditAttestation (auditorKey: string, campaignId: string, milestone: number, claim: SpendClaim): Promise<boolean> {
  if (claim.sats === undefined || claim.invoiceSha256 === undefined || claim.attestation === undefined) return false
  try {
    const { valid } = await new ProtoWallet('anyone').verifySignature({
      data: Utils.toArray(auditMessage(campaignId, milestone, claim.lineId, claim.sats, claim.invoiceSha256), 'utf8'),
      signature: Utils.toArray(claim.attestation, 'hex'),
      protocolID: AUDIT_PROTOCOL,
      keyID: campaignId,
      counterparty: auditorKey
    })
    return valid
  } catch {
    return false
  }
}

export const lineOf = (plan: PaymentPlan, milestone: number, lineId: string): PlanLine | undefined =>
  plan.milestones[milestone - 1]?.lines.find(l => l.id === lineId)

/**
 * Verify one claim. `output` is the referenced transaction output, already
 * SPV-verified by the caller (on-chain lines only).
 */
export async function verifySpendClaim (
  plan: PaymentPlan,
  campaignId: string,
  milestone: number,
  claim: SpendClaim,
  output?: { satoshis: number, lockingScript: string }
): Promise<VerifiedSpend> {
  const no = (reason: string): VerifiedSpend => ({ lineId: claim.lineId, verifiedSats: 0, ok: false, reason })
  const line = lineOf(plan, milestone, claim.lineId)
  if (line === undefined) return no(`no budget line "${claim.lineId}" in milestone ${milestone}`)
  if (line.payee.kind === 'onchain') {
    if (output === undefined) return no('payment transaction not found')
    if (output.lockingScript !== line.payee.lockingScript) return no(`the payment does not go to ${line.payee.name}`)
    return { lineId: line.id, verifiedSats: output.satoshis, ok: true, reason: `${output.satoshis} sats paid to ${line.payee.name}, verified by SPV` }
  }
  if (plan.auditorKey === undefined || !(await verifyAuditAttestation(plan.auditorKey, campaignId, milestone, claim))) return no('invoice is not signed by the plan\'s auditor')
  return { lineId: line.id, verifiedSats: claim.sats!, ok: true, reason: `invoice ${claim.invoiceSha256!.slice(0, 12)}… for ${claim.sats} sats, signed by the auditor` }
}

export interface LineResult {
  lineId: string
  category: string
  payee: string
  plannedSats: number
  spentSats: number
  /** |spent − planned| / planned, in percent (rounded to 0.1). */
  deviationPercent: number
  withinTolerance: boolean
}

export interface SpendingResult {
  milestone: number
  releasedSats: number
  lines: LineResult[]
  /** Spending that counts: per line, at most planned + tolerance. */
  compliantSats: number
  /** What the NGO must account for or pay back if the milestone is not compliant. */
  unaccountedSats: number
  /** Every line within tolerance. */
  ok: boolean
}

/** Planned satoshis for each line of a milestone, given what was released (largest remainder, so lines sum to the tranche). */
export function plannedSats (plan: PaymentPlan, milestone: number, releasedSats: number): Map<string, number> {
  const lines = plan.milestones[milestone - 1]?.lines ?? []
  const exact = lines.map(l => releasedSats * l.percent / 100)
  const out = exact.map(Math.floor)
  let rest = releasedSats - out.reduce((s, x) => s + x, 0)
  const order = exact.map((x, i) => [x - Math.floor(x), i] as const).sort((a, b) => b[0] - a[0])
  for (const [, i] of order) { if (rest <= 0) break; out[i]++; rest-- }
  return new Map(lines.map((l, i) => [l.id, out[i]]))
}

/**
 * Judge a released milestone's spending against the plan.
 *  - deviation per line = |spent − planned| / planned
 *  - ok when every line is within the tolerance
 *  - unaccounted = released − Σ min(spent, planned × (1 + tolerance)); zero when ok
 */
export function evaluateSpending (plan: PaymentPlan, milestone: number, releasedSats: number, spends: VerifiedSpend[]): SpendingResult {
  const planned = plannedSats(plan, milestone, releasedSats)
  const tol = plan.tolerancePercent / 100
  const lines: LineResult[] = (plan.milestones[milestone - 1]?.lines ?? []).map(l => {
    const p = planned.get(l.id) ?? 0
    const spent = spends.filter(s => s.ok && s.lineId === l.id).reduce((sum, s) => sum + s.verifiedSats, 0)
    const deviation = p === 0 ? (spent === 0 ? 0 : 100) : Math.abs(spent - p) / p
    return {
      lineId: l.id,
      category: l.category,
      payee: l.payee.name,
      plannedSats: p,
      spentSats: spent,
      deviationPercent: Math.round(deviation * 1000) / 10,
      withinTolerance: deviation <= tol + 1e-9
    }
  })
  const compliantSats = lines.reduce((s, l) => s + Math.min(l.spentSats, Math.floor(l.plannedSats * (1 + tol))), 0)
  const ok = lines.length > 0 && lines.every(l => l.withinTolerance)
  return { milestone, releasedSats, lines, compliantSats, unaccountedSats: ok ? 0 : Math.max(0, releasedSats - compliantSats), ok }
}
