/**
 * Bitcoin (BTC) primitives for the swap's Bitcoin leg, with no Bitcoin library: just what an
 * HTLC needs. Bitcoind checks every byte (a wrong sighash or script is refused), and so do the tests.
 *
 *  - the HTLC script (P2WSH), the same sha256 hashlock as the BSV AtomicSwap:
 *      OP_IF    OP_SIZE 32 OP_EQUALVERIFY OP_SHA256 <hashlock> OP_EQUALVERIFY <receiver>
 *      OP_ELSE  <refundAfter> OP_CHECKLOCKTIMEVERIFY OP_DROP <sender>
 *      OP_ENDIF OP_CHECKSIG
 *    The receiver claims with the secret at any time; the sender refunds once the chain's
 *    median time passes `refundAfter` (BIP 113). Unlike the EVM HTLC, nothing stops a claim after
 *    `refundAfter`: the receiver must claim well before it (the liquidity agent does).
 *  - segwit v0 transactions, the BIP 143 sighash (SIGHASH_ALL), low-S DER signatures;
 *  - bech32 addresses (BIP 173), so any wallet can fund the HTLC by paying an address.
 */
import { BigNumber, ECDSA, Hash, PrivateKey, Utils } from '@bsv/sdk'

type Bytes = number[]
const hex = (b: Bytes): string => Utils.toHex(b)
const bytes = (h: string): Bytes => Utils.toArray(h, 'hex')

// ── encoding ────────────────────────────────────────────────────────────────
const u32 = (n: number): Bytes => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]
const u64 = (n: number): Bytes => { let v = BigInt(n); const o: Bytes = []; for (let i = 0; i < 8; i++) { o.push(Number(v & 0xffn)); v >>= 8n } return o }
const varint = (n: number): Bytes => n < 0xfd ? [n] : n <= 0xffff ? [0xfd, n & 0xff, n >> 8] : [0xfe, ...u32(n)]
const varbytes = (b: Bytes): Bytes => [...varint(b.length), ...b]
/** Minimal script push of data (≤ 75 bytes is all an HTLC needs). */
const push = (b: Bytes): Bytes => { if (b.length > 75) throw new Error('push too long'); return [b.length, ...b] }
/** Minimal CScriptNum encoding of a positive number. */
const scriptNum = (n: number): Bytes => { const o: Bytes = []; let v = n; while (v > 0) { o.push(v & 0xff); v = Math.floor(v / 256) } if ((o[o.length - 1] & 0x80) !== 0) o.push(0); return o }

const OP = { IF: 0x63, ELSE: 0x67, ENDIF: 0x68, DROP: 0x75, SIZE: 0x82, EQUALVERIFY: 0x88, SHA256: 0xa8, CHECKSIG: 0xac, CLTV: 0xb1 }

export interface HtlcTerms { hashlock: string, receiver: string, sender: string, refundAfter: number }

export function htlcScript (t: HtlcTerms): Bytes {
  if (!/^[0-9a-f]{64}$/.test(t.hashlock)) throw new Error('hashlock must be 32 bytes hex')
  for (const k of [t.receiver, t.sender]) if (!/^0[23][0-9a-f]{64}$/.test(k)) throw new Error('keys must be compressed public keys (hex)')
  if (!Number.isSafeInteger(t.refundAfter) || t.refundAfter < 500_000_000) throw new Error('refundAfter must be a unix time')
  return [
    OP.IF, OP.SIZE, ...push([32]), OP.EQUALVERIFY, OP.SHA256, ...push(bytes(t.hashlock)), OP.EQUALVERIFY, ...push(bytes(t.receiver)),
    OP.ELSE, ...push(scriptNum(t.refundAfter)), OP.CLTV, OP.DROP, ...push(bytes(t.sender)),
    OP.ENDIF, OP.CHECKSIG
  ]
}

/** Read the terms back from a script; undefined if it is not exactly an HTLC of this shape. */
export function parseHtlcScript (script: Bytes): HtlcTerms | undefined {
  try {
    const at = (i: number, n: number): Bytes => { if (script[i] !== n) throw new Error('shape'); return script.slice(i + 1, i + 1 + n) }
    let i = 0
    const expect = (b: number): void => { if (script[i++] !== b) throw new Error('shape') }
    expect(OP.IF); expect(OP.SIZE); expect(1); expect(32); expect(OP.EQUALVERIFY); expect(OP.SHA256)
    const hashlock = at(i, 32); i += 33; expect(OP.EQUALVERIFY)
    const receiver = at(i, 33); i += 34; expect(OP.ELSE)
    const n = script[i]; if (n < 1 || n > 5) throw new Error('shape')
    const lt = script.slice(i + 1, i + 1 + n); i += 1 + n
    expect(OP.CLTV); expect(OP.DROP)
    const sender = at(i, 33); i += 34; expect(OP.ENDIF); expect(OP.CHECKSIG)
    if (i !== script.length) return undefined
    const refundAfter = lt.reduceRight((v, b) => v * 256 + b, 0)
    const t = { hashlock: hex(hashlock), receiver: hex(receiver), sender: hex(sender), refundAfter }
    return hex(htlcScript(t)) === hex(script) ? t : undefined // canonical encoding only
  } catch { return undefined }
}

/** P2WSH output script for a witness script: OP_0 <sha256(script)>. */
export const p2wsh = (witnessScript: Bytes): Bytes => [0x00, 0x20, ...Hash.sha256(witnessScript)]
/** P2WPKH output script for a compressed public key: OP_0 <hash160(key)>. */
export const p2wpkh = (pubKeyHex: string): Bytes => [0x00, 0x14, ...Hash.hash160(bytes(pubKeyHex))]

// ── bech32 (BIP 173, segwit v0 only) ────────────────────────────────────────
const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'
const polymod = (v: Bytes): number => {
  const G = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]
  let chk = 1
  for (const x of v) { const b = chk >>> 25; chk = ((chk & 0x1ffffff) << 5) ^ x; for (let i = 0; i < 5; i++) if (((b >>> i) & 1) !== 0) chk ^= G[i] }
  return chk >>> 0
}
const hrpExpand = (hrp: string): Bytes => [...[...hrp].map(c => c.charCodeAt(0) >> 5), 0, ...[...hrp].map(c => c.charCodeAt(0) & 31)]
const toWords = (data: Bytes): Bytes => { const o: Bytes = []; let acc = 0; let bits = 0; for (const b of data) { acc = (acc << 8) | b; bits += 8; while (bits >= 5) { bits -= 5; o.push((acc >> bits) & 31) } } if (bits > 0) o.push((acc << (5 - bits)) & 31); return o }

export type BtcNetwork = 'main' | 'test' | 'regtest'
const HRP: Record<BtcNetwork, string> = { main: 'bc', test: 'tb', regtest: 'bcrt' }

/** The address of a segwit v0 output script (P2WSH or P2WPKH). */
export function segwitAddress (outputScript: Bytes, network: BtcNetwork): string {
  if (outputScript[0] !== 0 || outputScript[1] !== outputScript.length - 2) throw new Error('not a segwit v0 output')
  const hrp = HRP[network]
  const data = [0, ...toWords(outputScript.slice(2))]
  const mod = polymod([...hrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0]) ^ 1
  const checksum = [0, 1, 2, 3, 4, 5].map(i => (mod >> (5 * (5 - i))) & 31)
  return `${hrp}1${[...data, ...checksum].map(d => CHARSET[d]).join('')}`
}

/**
 * The output script of a segwit address (v0 bech32: bc1q…, or v1+ bech32m: bc1p…), checked for this network.
 * Used for a refund destination the donor types in.
 */
export function decodeSegwitAddress (address: string, network: BtcNetwork): Bytes {
  const a = address.trim().toLowerCase()
  const sep = a.lastIndexOf('1')
  const hrp = a.slice(0, sep)
  if (hrp !== HRP[network]) throw new Error(`not a ${network} Bitcoin address (expected ${HRP[network]}1…)`)
  const data = [...a.slice(sep + 1)].map(c => { const i = CHARSET.indexOf(c); if (i < 0) throw new Error('invalid character in address'); return i })
  if (data.length < 7) throw new Error('address too short')
  const version = data[0]
  const check = polymod([...hrpExpand(hrp), ...data])
  if (check !== (version === 0 ? 1 : 0x2bc830a3)) throw new Error('address checksum failed')
  const words = data.slice(1, -6)
  const prog: Bytes = []; let acc = 0; let bits = 0
  for (const w of words) { acc = (acc << 5) | w; bits += 5; while (bits >= 8) { bits -= 8; prog.push((acc >> bits) & 0xff) } acc &= (1 << bits) - 1 }
  if (bits >= 5 || acc !== 0) throw new Error('invalid address padding')
  if (version > 16 || prog.length < 2 || prog.length > 40 || (version === 0 && prog.length !== 20 && prog.length !== 32)) throw new Error('invalid witness program')
  return [version === 0 ? 0 : 0x50 + version, prog.length, ...prog]
}

// ── transactions ────────────────────────────────────────────────────────────
export interface BtcInput { txid: string, vout: number, sequence: number, witness: Bytes[] }
export interface BtcOutput { script: Bytes, value: number }
export interface BtcTx { version: number, inputs: BtcInput[], outputs: BtcOutput[], lockTime: number }

const outpoint = (i: BtcInput): Bytes => [...bytes(i.txid).reverse(), ...u32(i.vout)]
const serializeOutputs = (outs: BtcOutput[]): Bytes => outs.flatMap(o => [...u64(o.value), ...varbytes(o.script)])

export function serializeTx (tx: BtcTx, withWitness = true): Bytes {
  const witness = withWitness && tx.inputs.some(i => i.witness.length > 0)
  return [
    ...u32(tx.version), ...(witness ? [0x00, 0x01] : []),
    ...varint(tx.inputs.length), ...tx.inputs.flatMap(i => [...outpoint(i), 0x00, ...u32(i.sequence)]),
    ...varint(tx.outputs.length), ...serializeOutputs(tx.outputs),
    ...(witness ? tx.inputs.flatMap(i => [...varint(i.witness.length), ...i.witness.flatMap(varbytes)]) : []),
    ...u32(tx.lockTime)
  ]
}

/** Transaction id (hex, display order): hash of the serialization without witnesses. */
export const txidOf = (tx: BtcTx): string => hex(Hash.hash256(serializeTx(tx, false)).reverse())

const SIGHASH_ALL = 0x01

/** BIP 143 signature hash of input `index`, spending `value` sats locked by `witnessScript`. */
export function sighashSegwitV0 (tx: BtcTx, index: number, witnessScript: Bytes, value: number): Bytes {
  const i = tx.inputs[index]
  return Hash.hash256([
    ...u32(tx.version),
    ...Hash.hash256(tx.inputs.flatMap(outpoint)),
    ...Hash.hash256(tx.inputs.flatMap(x => u32(x.sequence))),
    ...outpoint(i), ...varbytes(witnessScript), ...u64(value), ...u32(i.sequence),
    ...Hash.hash256(serializeOutputs(tx.outputs)),
    ...u32(tx.lockTime), ...u32(SIGHASH_ALL)
  ])
}

/** DER signature (low S, as Bitcoin's standardness rules require) + the SIGHASH_ALL byte. */
export function signSegwitV0 (key: PrivateKey, tx: BtcTx, index: number, witnessScript: Bytes, value: number): Bytes {
  const h = sighashSegwitV0(tx, index, witnessScript, value)
  const sig = ECDSA.sign(new BigNumber(hex(h), 16), key, true)
  return [...(sig.toDER() as Bytes), SIGHASH_ALL]
}

export interface HtlcSpend {
  /** The HTLC output being spent. */
  txid: string
  vout: number
  value: number
  witnessScript: Bytes
  /** Where the coins go (an output script), and the miner fee in sats. */
  to: Bytes
  fee: number
}

/** The receiver's claim: witness <sig> <secret> 1 <script>. */
export function claimTx (s: HtlcSpend, key: PrivateKey, secretHex: string): BtcTx {
  const tx: BtcTx = { version: 2, inputs: [{ txid: s.txid, vout: s.vout, sequence: 0xffffffff, witness: [] }], outputs: [{ script: s.to, value: s.value - s.fee }], lockTime: 0 }
  tx.inputs[0].witness = [signSegwitV0(key, tx, 0, s.witnessScript, s.value), bytes(secretHex), [1], s.witnessScript]
  return tx
}

/** The sender's refund after `refundAfter`: nLockTime = refundAfter, a non-final sequence, witness <sig> <empty> <script>. */
export function refundTx (s: HtlcSpend, key: PrivateKey, refundAfter: number): BtcTx {
  const tx: BtcTx = { version: 2, inputs: [{ txid: s.txid, vout: s.vout, sequence: 0xfffffffe, witness: [] }], outputs: [{ script: s.to, value: s.value - s.fee }], lockTime: refundAfter }
  tx.inputs[0].witness = [signSegwitV0(key, tx, 0, s.witnessScript, s.value), [], s.witnessScript]
  return tx
}

/** Parse just enough of a raw segwit transaction to read input witnesses (to find a revealed secret). */
export function witnessesOf (rawHex: string): Array<{ txid: string, vout: number, witness: Bytes[] }> {
  const b = bytes(rawHex); let p = 4
  const rd = (n: number): Bytes => { const o = b.slice(p, p + n); p += n; return o }
  const vi = (): number => { const f = b[p++]; if (f < 0xfd) return f; if (f === 0xfd) { const v = b[p] | (b[p + 1] << 8); p += 2; return v } const v = rd(4).reduceRight((a, x) => a * 256 + x, 0); return v }
  const segwit = b[p] === 0 && b[p + 1] === 1; if (segwit) p += 2
  const ins = Array.from({ length: vi() }, () => { const txid = hex(rd(32).reverse()); const vout = rd(4).reduceRight((a, x) => a * 256 + x, 0); rd(vi()); rd(4); return { txid, vout, witness: [] as Bytes[] } })
  const nOut = vi(); for (let k = 0; k < nOut; k++) { rd(8); rd(vi()) }
  if (segwit) for (const i of ins) { const n = vi(); for (let k = 0; k < n; k++) i.witness.push(rd(vi())) }
  return ins
}

export const btcPublicKey = (key: PrivateKey): string => key.toPublicKey().toString()
