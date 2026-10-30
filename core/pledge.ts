/**
 * CryptoPledgePotEscrow — @bsv/sdk runtime for the compiled sCrypt contract.
 *
 * The contract is written and compiled with sCrypt (contracts/src/contracts/
 * cryptoPledgePotEscrow.ts). The app only needs the compiled script template
 * (cryptoPledgePotEscrow.artifact.json): this module fills it in, reads its state,
 * computes the sighash preimages and assembles unlocking scripts, so the
 * browser and server work with plain @bsv/sdk objects and any BRC-100 wallet.
 *
 * The contract is stateless: a milestone release re-creates the identical
 * script holding the next remaining amount, so the escrow's value alone tells
 * how many milestones were released (see stageOf). That is why pledges must be
 * at least MIN_PLEDGE: every 1% step must free at least one satoshi.
 */
import { LockingScript, OP, Script, TransactionSignature, UnlockingScript, Utils, type Transaction } from '@bsv/sdk'
import artifact from './cryptoPledgePotEscrow.artifact.json'

export const MAX_MILESTONES = 4
export const BPS = 10_000
/** Smallest pledge for which every milestone step (>= 1%) frees at least 1 sat. */
export const MIN_PLEDGE = 100

/** Sighash for the release covenant's OP_PUSH_TX preimage. */
export const RELEASE_PREIMAGE_SCOPE =
  TransactionSignature.SIGHASH_SINGLE | TransactionSignature.SIGHASH_ANYONECANPAY | TransactionSignature.SIGHASH_FORKID
/** Sighash for every signature and for the refund preimage. */
export const ALL_SCOPE = TransactionSignature.SIGHASH_ALL | TransactionSignature.SIGHASH_FORKID

export const METHOD = { release: 0, refund: 1, refundFailed: 2 } as const

export interface PledgeTerms {
  /** sha256 of the campaign metadata, 32 bytes hex. */
  campaignId: string
  /** Creator's derived public key (compressed, hex). */
  creator: string
  /** Arbiter / vote-oracle public key (compressed, hex). */
  arbiter: string
  /** Donor's derived public key (compressed, hex). */
  donor: string
  /** Satoshis originally pledged. */
  pledged: number
  /** Cumulative release schedule in basis points, exactly MAX_MILESTONES entries. */
  cumulativeBps: number[]
  /** Unix time after which the donor may reclaim alone. */
  refundAfter: number
}

// ── Template ────────────────────────────────────────────────────────────────

type Part = { lit: string } | { arg: string }

const TEMPLATE: Part[] = (() => {
  const parts: Part[] = []
  const re = /<([^>]+)>/g
  let last = 0
  for (let m = re.exec(artifact.hex); m !== null; m = re.exec(artifact.hex)) {
    if (m.index > last) parts.push({ lit: artifact.hex.slice(last, m.index) })
    parts.push({ arg: m[1] })
    last = m.index + m[0].length
  }
  if (last < artifact.hex.length) parts.push({ lit: artifact.hex.slice(last) })
  return parts
})()

const pushBytesHex = (hex: string): string => new Script().writeBin(Utils.toArray(hex, 'hex')).toHex()
const pushNumberHex = (n: number | bigint): string => new Script().writeNumber(Number(n)).toHex()

function argValues (t: PledgeTerms): Record<string, string> {
  if (t.cumulativeBps.length !== MAX_MILESTONES) throw new Error(`cumulativeBps needs ${MAX_MILESTONES} entries`)
  if (!/^[0-9a-f]{64}$/i.test(t.campaignId)) throw new Error('campaignId must be 32 bytes hex')
  for (const k of [t.creator, t.arbiter, t.donor]) if (!/^0[23][0-9a-f]{64}$/i.test(k)) throw new Error('keys must be compressed public keys')
  const v: Record<string, string> = {
    campaignId: pushBytesHex(t.campaignId),
    creator: pushBytesHex(t.creator),
    arbiter: pushBytesHex(t.arbiter),
    donor: pushBytesHex(t.donor),
    pledged: pushNumberHex(t.pledged),
    refundAfter: pushNumberHex(t.refundAfter)
  }
  t.cumulativeBps.forEach((b, i) => { v[`cumulativeBps[${i}]`] = pushNumberHex(b) })
  return v
}

/** Locking script of a pledge escrow. It never changes across milestone releases. */
export function pledgeLockingScript (t: PledgeTerms): LockingScript {
  const v = argValues(t)
  return LockingScript.fromHex(TEMPLATE.map(p => ('lit' in p ? p.lit : v[p.arg])).join(''))
}

/** Read one script push at `hex[pos]` (hex offset). Returns its value bytes and the next offset. */
function readPush (hex: string, pos: number): { data: number[], num?: number, next: number } | undefined {
  const op = parseInt(hex.slice(pos, pos + 2), 16)
  if (Number.isNaN(op)) return undefined
  if (op === OP.OP_0) return { data: [], num: 0, next: pos + 2 }
  if (op === OP.OP_1NEGATE) return { data: [0x81], num: -1, next: pos + 2 }
  if (op >= OP.OP_1 && op <= OP.OP_16) return { data: [op - OP.OP_1 + 1], num: op - OP.OP_1 + 1, next: pos + 2 }
  let len: number
  let start: number
  if (op >= 1 && op <= 75) { len = op; start = pos + 2 } else if (op === OP.OP_PUSHDATA1) { len = parseInt(hex.slice(pos + 2, pos + 4), 16); start = pos + 4 } else if (op === OP.OP_PUSHDATA2) {
    len = parseInt(hex.slice(pos + 4, pos + 6) + hex.slice(pos + 2, pos + 4), 16); start = pos + 6
  } else return undefined
  const dataHex = hex.slice(start, start + len * 2)
  if (dataHex.length !== len * 2) return undefined
  return { data: Utils.toArray(dataHex, 'hex'), next: start + len * 2 }
}

const decodeNum = (data: number[]): number => {
  if (data.length === 0) return 0
  const neg = (data[data.length - 1] & 0x80) !== 0
  const mag = [...data]
  mag[mag.length - 1] &= 0x7f
  let n = 0
  for (let i = mag.length - 1; i >= 0; i--) n = n * 256 + mag[i]
  return neg ? -n : n
}

/** Parse a pledge escrow locking script. Returns undefined if it is not a CryptoPledgePotEscrow. */
export function parsePledgeScript (script: LockingScript | string): PledgeTerms | undefined {
  const hex = (typeof script === 'string' ? script : script.toHex()).toLowerCase()
  const values: Record<string, number[]> = {}
  let pos = 0
  for (const part of TEMPLATE) {
    if ('lit' in part) {
      if (hex.slice(pos, pos + part.lit.length) !== part.lit) return undefined
      pos += part.lit.length
    } else {
      const push = readPush(hex, pos)
      if (push === undefined) return undefined
      values[part.arg] = push.data
      pos = push.next
    }
  }
  if (pos !== hex.length) return undefined
  const terms: PledgeTerms = {
    campaignId: Utils.toHex(values.campaignId),
    creator: Utils.toHex(values.creator),
    arbiter: Utils.toHex(values.arbiter),
    donor: Utils.toHex(values.donor),
    pledged: decodeNum(values.pledged),
    cumulativeBps: Array.from({ length: MAX_MILESTONES }, (_, i) => decodeNum(values[`cumulativeBps[${i}]`])),
    refundAfter: decodeNum(values.refundAfter)
  }
  // Canonical encoding only: re-encode and compare, so one pledge has exactly one script.
  return pledgeLockingScript(terms).toHex() === hex ? terms : undefined
}

// ── Schedule ────────────────────────────────────────────────────────────────

/**
 * Turn per-milestone percentages (e.g. [25, 25, 50]) into the contract's
 * cumulative basis-point schedule, padded to MAX_MILESTONES with 10000.
 */
export function cumulativeSchedule (percentages: number[]): number[] {
  if (percentages.length < 1 || percentages.length > MAX_MILESTONES) throw new Error(`1 to ${MAX_MILESTONES} milestones`)
  if (percentages.some(p => !Number.isInteger(p) || p <= 0)) throw new Error('milestone percentages must be positive integers')
  if (percentages.reduce((a, b) => a + b, 0) !== 100) throw new Error('milestone percentages must add up to 100')
  const out: number[] = []
  let acc = 0
  for (const p of percentages) { acc += p * 100; out.push(acc) }
  while (out.length < MAX_MILESTONES) out.push(BPS)
  return out
}

/** True when every milestone frees at least one satoshi, so value ↔ stage is one-to-one. */
export function scheduleIsStrict (t: Pick<PledgeTerms, 'pledged' | 'cumulativeBps'>): boolean {
  let prev = t.pledged
  for (let stage = 1; stage <= MAX_MILESTONES; stage++) {
    const next = escrowedAfter(t, stage)
    if (prev === 0) break
    if (next >= prev) return false
    prev = next
  }
  return true
}

/** Milestones already released, read from the escrow's current value (as the contract does). */
export function stageOf (t: Pick<PledgeTerms, 'pledged' | 'cumulativeBps'>, value: number): number | undefined {
  for (let stage = 0; stage <= MAX_MILESTONES; stage++) if (escrowedAfter(t, stage) === value) return stage
  return undefined
}

/** Satoshis still escrowed after `stage` milestones (mirrors the contract's integer maths). */
export function escrowedAfter (t: Pick<PledgeTerms, 'pledged' | 'cumulativeBps'>, stage: number): number {
  if (stage === 0) return t.pledged
  const bps = t.cumulativeBps[Math.min(stage, MAX_MILESTONES) - 1]
  return t.pledged - Math.floor((t.pledged * bps) / BPS)
}

// ── Preimages and unlocking scripts ────────────────────────────────────────

export interface SourceOutput { satoshis: number, lockingScript: LockingScript }

/** BIP-143 sighash preimage of input `inputIndex` of `tx` for `scope`. */
export function preimage (tx: Transaction, inputIndex: number, scope: number, source?: SourceOutput): number[] {
  const input = tx.inputs[inputIndex]
  const src = source ?? input.sourceTransaction?.outputs[input.sourceOutputIndex]
  if (src === undefined || src.satoshis === undefined) throw new Error(`input ${inputIndex}: source output unknown`)
  return TransactionSignature.format({
    sourceTXID: input.sourceTXID ?? input.sourceTransaction!.id('hex'),
    sourceOutputIndex: input.sourceOutputIndex,
    sourceSatoshis: src.satoshis,
    transactionVersion: tx.version,
    otherInputs: tx.inputs.filter((_, i) => i !== inputIndex),
    inputIndex,
    outputs: tx.outputs,
    inputSequence: input.sequence ?? 0xffffffff,
    subscript: src.lockingScript,
    lockTime: tx.lockTime,
    scope
  })
}

const push = (s: Script, data: number[]): Script => s.writeBin(data)

/** Unlock: release(creatorSig, arbiterSig, preimage). Sigs in checksig format (DER + sighash byte). */
export function releaseUnlock (creatorSig: number[], arbiterSig: number[], txPreimage: number[]): UnlockingScript {
  const s = push(push(push(new Script(), creatorSig), arbiterSig), txPreimage).writeNumber(METHOD.release)
  return UnlockingScript.fromHex(s.toHex())
}

/** Unlock: refund(donorSig, preimage). The tx needs nLockTime >= refundAfter and a non-final input sequence. */
export function refundUnlock (donorSig: number[], txPreimage: number[]): UnlockingScript {
  const s = push(push(new Script(), donorSig), txPreimage).writeNumber(METHOD.refund)
  return UnlockingScript.fromHex(s.toHex())
}

/** Unlock: refundFailed(donorSig, arbiterSig). */
export function refundFailedUnlock (donorSig: number[], arbiterSig: number[]): UnlockingScript {
  const s = push(push(new Script(), donorSig), arbiterSig).writeNumber(METHOD.refundFailed)
  return UnlockingScript.fromHex(s.toHex())
}

const pushLen = (n: number): number => (n <= 75 ? 1 : n <= 255 ? 2 : n <= 0xffff ? 3 : 5) + n
const MAX_SIG = 73
/** Upper bound of a preimage for a locking script of `scriptLen` bytes. */
const preimageLen = (scriptLen: number): number => 4 + 32 + 32 + 36 + (scriptLen < 0xfd ? 1 : 3) + scriptLen + 8 + 4 + 32 + 4 + 4

/** unlockingScriptLength hints for createAction. */
export const unlockLength = {
  release: (scriptLen: number) => pushLen(MAX_SIG) * 2 + pushLen(preimageLen(scriptLen)) + 1,
  refund: (scriptLen: number) => pushLen(MAX_SIG) + pushLen(preimageLen(scriptLen)) + 1,
  refundFailed: () => pushLen(MAX_SIG) * 2 + 1
}

export const PLEDGE_ARTIFACT = { contract: artifact.contract, md5: artifact.md5, compilerVersion: artifact.compilerVersion }
