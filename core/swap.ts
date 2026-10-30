/**
 * AtomicSwap (BSV half of a cross-chain HTLC): @bsv/sdk runtime for the
 * compiled sCrypt contract (contracts/src/contracts/atomicSwap.ts).
 * Same approach as core/pledge.ts: fill the compiled template, parse it back
 * canonically, build preimages and unlocking scripts.
 */
import { Hash, LockingScript, OP, Random, Script, UnlockingScript, Utils } from '@bsv/sdk'
import artifact from './atomicSwap.artifact.json'

export interface SwapTerms {
  /** sha256(secret), 32 bytes hex. The same hash locks the other chain. */
  hashlock: string
  /** Receives the sats when the secret is shown (compressed pubkey hex). */
  receiver: string
  /** Locked the sats; refunds after refundAfter (compressed pubkey hex). */
  sender: string
  /** Unix seconds. */
  refundAfter: number
}

export const SWAP_METHOD = { claim: 0, refund: 1 } as const

type Part = { lit: string } | { arg: keyof SwapTerms }
const TEMPLATE: Part[] = (() => {
  const parts: Part[] = []
  const re = /<([^>]+)>/g
  let last = 0
  for (let m = re.exec(artifact.hex); m !== null; m = re.exec(artifact.hex)) {
    if (m.index > last) parts.push({ lit: artifact.hex.slice(last, m.index) })
    parts.push({ arg: m[1] as keyof SwapTerms })
    last = m.index + m[0].length
  }
  if (last < artifact.hex.length) parts.push({ lit: artifact.hex.slice(last) })
  return parts
})()

const isKey = (k: string): boolean => /^0[23][0-9a-f]{64}$/i.test(k)
const pushHex = (hex: string): string => new Script().writeBin(Utils.toArray(hex, 'hex')).toHex()

/** A fresh 32-byte secret and its hashlock. */
export function newSecret (): { secret: string, hashlock: string } {
  const secret = Utils.toHex(Random(32))
  return { secret, hashlock: hashlockOf(secret) }
}
export const hashlockOf = (secretHex: string): string => Utils.toHex(Hash.sha256(Utils.toArray(secretHex, 'hex')))

export function swapLockingScript (t: SwapTerms): LockingScript {
  if (!/^[0-9a-f]{64}$/i.test(t.hashlock)) throw new Error('hashlock must be 32 bytes hex')
  if (!isKey(t.receiver) || !isKey(t.sender)) throw new Error('keys must be compressed public keys')
  if (!Number.isSafeInteger(t.refundAfter) || t.refundAfter < 500_000_000) throw new Error('refundAfter must be unix seconds')
  const v: Record<keyof SwapTerms, string> = {
    hashlock: pushHex(t.hashlock),
    receiver: pushHex(t.receiver),
    sender: pushHex(t.sender),
    refundAfter: new Script().writeNumber(t.refundAfter).toHex()
  }
  return LockingScript.fromHex(TEMPLATE.map(p => ('lit' in p ? p.lit : v[p.arg])).join(''))
}

function readPush (hex: string, pos: number): { data: number[], next: number } | undefined {
  const op = parseInt(hex.slice(pos, pos + 2), 16)
  if (Number.isNaN(op)) return undefined
  if (op === OP.OP_0) return { data: [], next: pos + 2 }
  if (op >= OP.OP_1 && op <= OP.OP_16) return { data: [op - OP.OP_1 + 1], next: pos + 2 }
  let len: number, start: number
  if (op >= 1 && op <= 75) { len = op; start = pos + 2 } else if (op === OP.OP_PUSHDATA1) { len = parseInt(hex.slice(pos + 2, pos + 4), 16); start = pos + 4 } else return undefined
  const dataHex = hex.slice(start, start + len * 2)
  return dataHex.length === len * 2 ? { data: Utils.toArray(dataHex, 'hex'), next: start + len * 2 } : undefined
}

const decodeNum = (d: number[]): number => {
  if (d.length === 0) return 0
  let n = 0
  for (let i = d.length - 1; i >= 0; i--) n = n * 256 + (i === d.length - 1 ? d[i] & 0x7f : d[i])
  return (d[d.length - 1] & 0x80) !== 0 ? -n : n
}

/** The terms of an AtomicSwap output, or undefined if it isn't one (canonical encoding only). */
export function parseSwapScript (script: LockingScript | string): SwapTerms | undefined {
  const hex = (typeof script === 'string' ? script : script.toHex()).toLowerCase()
  const values: Partial<Record<keyof SwapTerms, number[]>> = {}
  let pos = 0
  for (const part of TEMPLATE) {
    if ('lit' in part) {
      if (hex.slice(pos, pos + part.lit.length) !== part.lit) return undefined
      pos += part.lit.length
    } else {
      const p = readPush(hex, pos)
      if (p === undefined) return undefined
      values[part.arg] = p.data
      pos = p.next
    }
  }
  if (pos !== hex.length) return undefined
  try {
    const terms: SwapTerms = {
      hashlock: Utils.toHex(values.hashlock!), receiver: Utils.toHex(values.receiver!), sender: Utils.toHex(values.sender!), refundAfter: decodeNum(values.refundAfter!)
    }
    return swapLockingScript(terms).toHex() === hex ? terms : undefined
  } catch { return undefined }
}

/** claim(secret, receiverSig): reveals the secret on chain. */
export const claimUnlock = (secretHex: string, receiverSig: number[]): UnlockingScript =>
  UnlockingScript.fromHex(new Script().writeBin(Utils.toArray(secretHex, 'hex')).writeBin(receiverSig).writeNumber(SWAP_METHOD.claim).toHex())

/** refund(senderSig, preimage): needs nLockTime ≥ refundAfter and a non-final input sequence. */
export const swapRefundUnlock = (senderSig: number[], txPreimage: number[]): UnlockingScript =>
  UnlockingScript.fromHex(new Script().writeBin(senderSig).writeBin(txPreimage).writeNumber(SWAP_METHOD.refund).toHex())

/** Read the secret out of a claim transaction's input (how the other side learns it). */
export function secretFromClaim (unlocking: UnlockingScript | Script): string | undefined {
  const c = unlocking.chunks
  if (c.length !== 3 || c[2].op !== OP.OP_0) return undefined
  const secret = c[0].data
  return secret !== undefined && secret.length === 32 ? Utils.toHex(secret) : undefined
}

const pushLen = (n: number): number => (n <= 75 ? 1 : n <= 255 ? 2 : 3) + n
const preimageLen = (scriptLen: number): number => 4 + 32 + 32 + 36 + (scriptLen < 0xfd ? 1 : 3) + scriptLen + 8 + 4 + 32 + 4 + 4
export const swapUnlockLength = {
  claim: () => pushLen(32) + pushLen(73) + 1,
  refund: (scriptLen: number) => pushLen(73) + pushLen(preimageLen(scriptLen)) + 1
}
