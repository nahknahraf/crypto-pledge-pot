/**
 * CryptoPledgePot campaign model and on-chain records.
 *
 * A campaign is a canonical JSON document. Its id is sha256 of that JSON, and
 * the id is baked into every pledge escrow, so a pledge provably belongs to
 * exactly one set of terms (goal, deadline, milestones, keys).
 *
 * On-chain records (OP_FALSE OP_RETURN, provably unspendable, 0 sats):
 *   campaign anchor:  'cryptopledgepot' 'campaign' <campaignId> <canonical JSON>
 *   donation memo:    'cryptopledgepot' 'pledge'   <campaignId> <JSON {name, message}>
 *   breach record:    'cryptopledgepot' 'breach'   <campaignId> <JSON BreachRecord> (written by the compliance agent)
 * Anyone can rebuild the index from the chain with these.
 */
import { Hash, OP, Script, Utils, type LockingScript, type WalletProtocol } from '@bsv/sdk'
import { cumulativeSchedule, MAX_MILESTONES, pledgeLockingScript, type PledgeTerms } from './pledge'
import { validatePaymentPlan, verifyPaymentPlanSignature, type PaymentPlan } from './paymentPlan'

/**
 * Protocol tag: names the OP_RETURN records and every key-derivation protocol.
 * 'bitfund' is the app's pre-rename name: campaigns and pledges made with it
 * stay readable and spendable (their keys were derived with 'bitfund …').
 */
export type ProtocolTag = 'cryptopledgepot' | 'bitfund'
export const CRYPTOPLEDGEPOT: ProtocolTag = 'cryptopledgepot'
export const PROTOCOL_TAGS: readonly ProtocolTag[] = ['cryptopledgepot', 'bitfund']
export const isProtocolTag = (s: unknown): s is ProtocolTag => typeof s === 'string' && (PROTOCOL_TAGS as readonly string[]).includes(s)

export interface Protocols { creator: WalletProtocol, donor: WalletProtocol, arbiter: WalletProtocol, basket: string }
export const protocolsFor = (tag: ProtocolTag): Protocols => ({
  creator: [1, `${tag} creator`],
  donor: [1, `${tag} donor`],
  arbiter: [1, `${tag} arbiter`],
  basket: `${tag} pledges`
})

const CURRENT = protocolsFor(CRYPTOPLEDGEPOT)
export const CREATOR_PROTOCOL: WalletProtocol = CURRENT.creator
export const DONOR_PROTOCOL: WalletProtocol = CURRENT.donor
export const ARBITER_PROTOCOL: WalletProtocol = CURRENT.arbiter
export const PLEDGE_BASKET = CURRENT.basket

export const LIMITS = { title: 80, description: 4000, milestoneTitle: 80, name: 40, message: 280 } as const

export interface Milestone {
  title: string
  /** Share of every pledge released when this milestone is approved. */
  percent: number
}

export interface CampaignMeta {
  v: 1
  title: string
  description: string
  imageUrl?: string
  /** Funding goal in satoshis (all-or-nothing). */
  goal: number
  /** Unix seconds. Pledges are accepted until then; the goal must be met by then. */
  deadline: number
  /** Unix seconds. After this the donor alone can reclaim whatever is still escrowed. */
  refundAfter: number
  milestones: Milestone[]
  creatorIdentityKey: string
  /** Creator's derived key (CREATOR_PROTOCOL, keyID = nonce). */
  creatorKey: string
  /** Arbiter key for this campaign (ARBITER_PROTOCOL, keyID = nonce). */
  arbiterKey: string
  /** 16 random bytes hex: keyID of the creator and arbiter keys. */
  nonce: string
  createdAt: number
  /** 'agent' = the creator is an autonomous AI service raising its operating budget. */
  kind?: 'agent'
  /** Where the agent publishes its status and spend ledger (http(s) URL). */
  agentUrl?: string
  /**
   * NGO payment plan (core/paymentPlan.ts): how each milestone's money will be
   * spent. Part of the campaign id, so it is fixed once the campaign exists.
   */
  paymentPlan?: PaymentPlan
  /** The creator's signature over the plan (DER hex, PAYMENT_PLAN_PROTOCOL, keyID = nonce, counterparty 'anyone'). */
  paymentPlanSignature?: string
}

/** JSON with sorted keys, no whitespace: the form that is hashed and anchored. */
export function canonicalJson (value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export const campaignIdOf = (meta: CampaignMeta): string => Utils.toHex(Hash.sha256(canonicalJson(meta), 'utf8'))

const isKey = (k: unknown): boolean => typeof k === 'string' && /^0[23][0-9a-f]{64}$/.test(k)

/** Throws with a readable message if `meta` is not a valid campaign. */
export function validateCampaign (meta: CampaignMeta): void {
  const fail = (m: string): never => { throw new Error(`invalid campaign: ${m}`) }
  if (meta.v !== 1) fail('unsupported version')
  if (typeof meta.title !== 'string' || meta.title.trim() === '' || meta.title.length > LIMITS.title) fail(`title must be 1–${LIMITS.title} characters`)
  if (typeof meta.description !== 'string' || meta.description.length > LIMITS.description) fail(`description must be at most ${LIMITS.description} characters`)
  if (meta.imageUrl !== undefined && !/^https:\/\/\S+$/.test(meta.imageUrl)) fail('imageUrl must be an https URL')
  if (!Number.isSafeInteger(meta.goal) || meta.goal < 1) fail('goal must be a positive number of satoshis')
  if (!Number.isSafeInteger(meta.deadline) || meta.deadline < 500_000_000) fail('deadline must be unix seconds')
  if (!Number.isSafeInteger(meta.refundAfter) || meta.refundAfter <= meta.deadline || meta.refundAfter > 0xffffffff) fail('refundAfter must be after the deadline')
  if (!Array.isArray(meta.milestones) || meta.milestones.length < 1 || meta.milestones.length > MAX_MILESTONES) fail(`1 to ${MAX_MILESTONES} milestones`)
  for (const m of meta.milestones) {
    if (typeof m.title !== 'string' || m.title.trim() === '' || m.title.length > LIMITS.milestoneTitle) fail('every milestone needs a title')
  }
  try { cumulativeSchedule(meta.milestones.map(m => m.percent)) } catch (e) { fail((e as Error).message) }
  if (!isKey(meta.creatorIdentityKey) || !isKey(meta.creatorKey) || !isKey(meta.arbiterKey)) fail('keys must be compressed public keys')
  if (!/^[0-9a-f]{32}$/.test(meta.nonce)) fail('nonce must be 16 bytes hex')
  if (!Number.isSafeInteger(meta.createdAt)) fail('createdAt must be unix seconds')
  if (meta.kind !== undefined && meta.kind !== 'agent') fail('kind must be "agent" when set')
  if (meta.agentUrl !== undefined && (!/^https?:\/\/[^\s]+$/.test(meta.agentUrl) || meta.agentUrl.length > 200)) fail('agentUrl must be an http(s) URL')
  if ((meta.paymentPlan === undefined) !== (meta.paymentPlanSignature === undefined)) fail('a payment plan needs the creator\'s signature, and a signature needs a plan')
  if (meta.paymentPlan !== undefined) {
    try { validatePaymentPlan(meta.paymentPlan, meta.milestones.length) } catch (e) { fail((e as Error).message) }
    if (!/^([0-9a-f]{2}){8,80}$/.test(meta.paymentPlanSignature ?? '')) fail('paymentPlanSignature must be a DER signature in hex')
  }
}

/** True when the campaign has no payment plan, or its plan carries a valid signature by the creator. */
export async function paymentPlanSigned (meta: CampaignMeta): Promise<boolean> {
  if (meta.paymentPlan === undefined) return true
  return await verifyPaymentPlanSignature(meta.paymentPlan, meta.paymentPlanSignature ?? '', meta.creatorIdentityKey, meta.nonce)
}

/** Escrow terms for a pledge of `satoshis` from `donorKey` to this campaign. */
export function pledgeTerms (meta: CampaignMeta, donorKey: string, satoshis: number): PledgeTerms {
  return {
    campaignId: campaignIdOf(meta),
    creator: meta.creatorKey,
    arbiter: meta.arbiterKey,
    donor: donorKey,
    pledged: satoshis,
    cumulativeBps: cumulativeSchedule(meta.milestones.map(m => m.percent)),
    refundAfter: meta.refundAfter
  }
}

export const pledgeScriptFor = (meta: CampaignMeta, donorKey: string, satoshis: number): LockingScript =>
  pledgeLockingScript(pledgeTerms(meta, donorKey, satoshis))

// ── OP_RETURN records ───────────────────────────────────────────────────────

const utf8 = (s: string): number[] => Utils.toArray(s, 'utf8')

function opReturn (fields: number[][]): Script {
  const s = new Script().writeOpCode(OP.OP_FALSE).writeOpCode(OP.OP_RETURN)
  for (const f of fields) s.writeBin(f)
  return s
}

export const campaignAnchorScript = (meta: CampaignMeta, tag: ProtocolTag = CRYPTOPLEDGEPOT): Script =>
  opReturn([utf8(tag), utf8('campaign'), Utils.toArray(campaignIdOf(meta), 'hex'), utf8(canonicalJson(meta))])

export interface PledgeMemo { name?: string, message?: string }

export function pledgeMemoScript (campaignId: string, memo: PledgeMemo, tag: ProtocolTag = CRYPTOPLEDGEPOT): Script {
  const clean: PledgeMemo = {
    name: memo.name?.trim().slice(0, LIMITS.name) || undefined,
    message: memo.message?.trim().slice(0, LIMITS.message) || undefined
  }
  return opReturn([utf8(tag), utf8('pledge'), Utils.toArray(campaignId, 'hex'), utf8(canonicalJson(clean))])
}

/** Public, permanent record that a campaign breached its payment plan. */
export interface BreachRecord { milestone: number, unaccountedSats: number, repaidSats: number, graceEndedAt: number, lines: Array<{ lineId: string, plannedSats: number, spentSats: number }> }

export const breachRecordScript = (campaignId: string, record: BreachRecord, tag: ProtocolTag = CRYPTOPLEDGEPOT): Script =>
  opReturn([utf8(tag), utf8('breach'), Utils.toArray(campaignId, 'hex'), utf8(canonicalJson(record))])

export type CryptoPledgePotRecord =
  | { kind: 'campaign', tag: ProtocolTag, campaignId: string, meta: CampaignMeta }
  | { kind: 'pledge', tag: ProtocolTag, campaignId: string, memo: PledgeMemo }
  | { kind: 'breach', tag: ProtocolTag, campaignId: string, record: BreachRecord }

/** Decode a CryptoPledgePot OP_RETURN output, or undefined if it is not one. */
export function parseCryptoPledgePotRecord (script: Script | string): CryptoPledgePotRecord | undefined {
  try {
    const s = typeof script === 'string' ? Script.fromHex(script) : script
    if (s.chunks.length !== 2 || s.chunks[0].op !== OP.OP_FALSE || s.chunks[1].op !== OP.OP_RETURN) return undefined
    // The SDK keeps everything after OP_RETURN as one data blob; read the pushes inside it.
    const c = Script.fromBinary(s.chunks[1].data ?? []).chunks
    if (c.length !== 4) return undefined
    const text = (i: number): string => Utils.toUTF8(c[i].data ?? [])
    const tag = text(0)
    if (!isProtocolTag(tag)) return undefined
    const campaignId = Utils.toHex(c[2].data ?? [])
    if (campaignId.length !== 64) return undefined
    const payload = JSON.parse(text(3))
    if (text(1) === 'campaign') {
      if (campaignIdOf(payload) !== campaignId) return undefined
      return { kind: 'campaign', tag, campaignId, meta: payload }
    }
    if (text(1) === 'pledge') {
      return { kind: 'pledge', tag, campaignId, memo: { name: typeof payload.name === 'string' ? payload.name : undefined, message: typeof payload.message === 'string' ? payload.message : undefined } }
    }
    if (text(1) === 'breach') return { kind: 'breach', tag, campaignId, record: payload }
  } catch { /* not ours */ }
  return undefined
}

// ── Status ─────────────────────────────────────────────────────────────────

/** 'breached': the creator broke its payment plan (core/compliance.ts); set by the indexer's view, never by campaignStatus(). */
export type CampaignStatus = 'active' | 'funded' | 'failed' | 'completed' | 'breached'

export function campaignStatus (meta: CampaignMeta, raised: number, milestonesReleased: number, now = Math.floor(Date.now() / 1000)): CampaignStatus {
  if (milestonesReleased >= meta.milestones.length) return 'completed'
  if (now < meta.deadline) return 'active'
  return raised >= meta.goal ? 'funded' : 'failed'
}

/** Message a donor signs (with the escrow's donor key) to claim an imported pledge for their identity. */
export const claimMessage = (pledgeId: string, identityKey: string): string => `cryptopledgepot claim ${pledgeId} for ${identityKey}`
