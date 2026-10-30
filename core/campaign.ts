/**
 * BitFund campaign model and on-chain records.
 *
 * A campaign is a canonical JSON document. Its id is sha256 of that JSON, and
 * the id is baked into every pledge escrow, so a pledge provably belongs to
 * exactly one set of terms (goal, deadline, milestones, keys).
 *
 * On-chain records (OP_FALSE OP_RETURN, provably unspendable, 0 sats):
 *   campaign anchor:  'bitfund' 'campaign' <campaignId> <canonical JSON>
 *   donation memo:    'bitfund' 'pledge'   <campaignId> <JSON {name, message}>
 * Anyone can rebuild the index from the chain with these.
 */
import { Hash, OP, Script, Utils, type LockingScript, type WalletProtocol } from '@bsv/sdk'
import { cumulativeSchedule, MAX_MILESTONES, pledgeLockingScript, type PledgeTerms } from './pledge'

export const BITFUND = 'bitfund'
export const CREATOR_PROTOCOL: WalletProtocol = [1, 'bitfund creator']
export const DONOR_PROTOCOL: WalletProtocol = [1, 'bitfund donor']
export const ARBITER_PROTOCOL: WalletProtocol = [1, 'bitfund arbiter']
export const PLEDGE_BASKET = 'bitfund pledges'

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

export const campaignAnchorScript = (meta: CampaignMeta): Script =>
  opReturn([utf8(BITFUND), utf8('campaign'), Utils.toArray(campaignIdOf(meta), 'hex'), utf8(canonicalJson(meta))])

export interface PledgeMemo { name?: string, message?: string }

export function pledgeMemoScript (campaignId: string, memo: PledgeMemo): Script {
  const clean: PledgeMemo = {
    name: memo.name?.trim().slice(0, LIMITS.name) || undefined,
    message: memo.message?.trim().slice(0, LIMITS.message) || undefined
  }
  return opReturn([utf8(BITFUND), utf8('pledge'), Utils.toArray(campaignId, 'hex'), utf8(canonicalJson(clean))])
}

export type BitfundRecord =
  | { kind: 'campaign', campaignId: string, meta: CampaignMeta }
  | { kind: 'pledge', campaignId: string, memo: PledgeMemo }

/** Decode a BitFund OP_RETURN output, or undefined if it is not one. */
export function parseBitfundRecord (script: Script | string): BitfundRecord | undefined {
  try {
    const s = typeof script === 'string' ? Script.fromHex(script) : script
    if (s.chunks.length !== 2 || s.chunks[0].op !== OP.OP_FALSE || s.chunks[1].op !== OP.OP_RETURN) return undefined
    // The SDK keeps everything after OP_RETURN as one data blob; read the pushes inside it.
    const c = Script.fromBinary(s.chunks[1].data ?? []).chunks
    if (c.length !== 4) return undefined
    const text = (i: number): string => Utils.toUTF8(c[i].data ?? [])
    if (text(0) !== BITFUND) return undefined
    const campaignId = Utils.toHex(c[2].data ?? [])
    if (campaignId.length !== 64) return undefined
    const payload = JSON.parse(text(3))
    if (text(1) === 'campaign') {
      if (campaignIdOf(payload) !== campaignId) return undefined
      return { kind: 'campaign', campaignId, meta: payload }
    }
    if (text(1) === 'pledge') {
      return { kind: 'pledge', campaignId, memo: { name: typeof payload.name === 'string' ? payload.name : undefined, message: typeof payload.message === 'string' ? payload.message : undefined } }
    }
  } catch { /* not ours */ }
  return undefined
}

// ── Status ─────────────────────────────────────────────────────────────────

export type CampaignStatus = 'active' | 'funded' | 'failed' | 'completed'

export function campaignStatus (meta: CampaignMeta, raised: number, milestonesReleased: number, now = Math.floor(Date.now() / 1000)): CampaignStatus {
  if (milestonesReleased >= meta.milestones.length) return 'completed'
  if (now < meta.deadline) return 'active'
  return raised >= meta.goal ? 'funded' : 'failed'
}
