/**
 * BOLT 11 Lightning invoices, decoded and signature-checked with no Lightning library
 * (https://github.com/lightning/bolts/blob/master/11-payment-encoding.md). Browser-safe.
 *
 * Why: a donor paying from ANY Lightning wallet must check, before paying, that the invoice the
 * liquidity agent issued pays under the donor's own hashlock, for the agreed amount, to the agent's
 * node, with a long enough timeout. The payee is recovered from the invoice signature, so a
 * tampered invoice can't claim to be from the agent.
 */
import { BigNumber, Hash, Signature, Utils } from '@bsv/sdk'

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'
const polymod = (v: number[]): number => {
  const G = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]
  let chk = 1
  for (const x of v) { const b = chk >>> 25; chk = ((chk & 0x1ffffff) << 5) ^ x; for (let i = 0; i < 5; i++) if (((b >>> i) & 1) !== 0) chk ^= G[i] }
  return chk >>> 0
}
const hrpExpand = (hrp: string): number[] => [...[...hrp].map(c => c.charCodeAt(0) >> 5), 0, ...[...hrp].map(c => c.charCodeAt(0) & 31)]
/** 5-bit words → bytes; `pad` keeps a final partial byte (for the signed message), else it is dropped. */
const wordsToBytes = (words: number[], pad: boolean): number[] => {
  const out: number[] = []; let acc = 0; let bits = 0
  for (const w of words) { acc = (acc << 5) | w; bits += 5; while (bits >= 8) { bits -= 8; out.push((acc >> bits) & 0xff) } acc &= (1 << bits) - 1 }
  if (pad && bits > 0) out.push((acc << (8 - bits)) & 0xff)
  return out
}
const wordsToInt = (words: number[]): number => words.reduce((n, w) => n * 32 + w, 0)

export type LnNetwork = 'main' | 'test' | 'signet' | 'regtest'
const PREFIX: Array<[string, LnNetwork]> = [['lnbcrt', 'regtest'], ['lntbs', 'signet'], ['lntb', 'test'], ['lnbc', 'main']]

export interface DecodedInvoice {
  network: LnNetwork
  /** Amount in sats, rounded down; undefined for an "any amount" invoice. */
  amountSat?: number
  amountMsat?: bigint
  timestamp: number
  /** Unix time after which the invoice can no longer be paid. */
  expiresAt: number
  paymentHash: string
  /** The payee's node public key, recovered from the signature (and checked against the `n` field if present). */
  payee: string
  /** Blocks the final HTLC must stay open at least (`c`, default 18). */
  minFinalCltv: number
  description?: string
}

export function decodeInvoice (invoice: string): DecodedInvoice {
  const s = invoice.trim().toLowerCase().replace(/^lightning:/, '')
  const sep = s.lastIndexOf('1')
  if (sep < 4) throw new Error('not a Lightning invoice')
  const hrp = s.slice(0, sep)
  const words = [...s.slice(sep + 1)].map(c => { const i = CHARSET.indexOf(c); if (i < 0) throw new Error('invalid character in invoice'); return i })
  if (words.length < 7 + 104 + 6) throw new Error('invoice too short')
  if (polymod([...hrpExpand(hrp), ...words]) !== 1) throw new Error('invoice checksum failed')
  const data = words.slice(0, -6)

  const pre = PREFIX.find(([p]) => hrp.startsWith(p))
  if (pre === undefined) throw new Error(`unknown invoice prefix ${hrp}`)
  const [prefix, network] = pre
  const amt = hrp.slice(prefix.length)
  let amountMsat: bigint | undefined
  if (amt !== '') {
    const m = amt.match(/^(\d+)([munp]?)$/)
    if (m === null) throw new Error('invalid invoice amount')
    const perUnit = { '': 100_000_000_000n, m: 100_000_000n, u: 100_000n, n: 100n, p: 0n }[m[2] as '' | 'm' | 'u' | 'n' | 'p']
    if (m[2] === 'p') { if (BigInt(m[1]) % 10n !== 0n) throw new Error('invalid pico amount'); amountMsat = BigInt(m[1]) / 10n } else amountMsat = BigInt(m[1]) * perUnit
  }

  const sigWords = data.slice(-104)
  const body = data.slice(0, -104)
  const timestamp = wordsToInt(body.slice(0, 7))
  let paymentHash: string | undefined; let declaredPayee: string | undefined; let description: string | undefined
  let expiry = 3600; let minFinalCltv = 18
  for (let i = 7; i < body.length;) {
    const type = body[i]; const len = body[i + 1] * 32 + body[i + 2]
    const field = body.slice(i + 3, i + 3 + len)
    if (i + 3 + len > body.length) throw new Error('truncated invoice field')
    i += 3 + len
    if (type === 1 && len === 52) paymentHash = Utils.toHex(wordsToBytes(field, false))
    else if (type === 19 && len === 53) declaredPayee = Utils.toHex(wordsToBytes(field, false))
    else if (type === 6) expiry = wordsToInt(field)
    else if (type === 24) minFinalCltv = wordsToInt(field)
    else if (type === 13) description = Utils.toUTF8(wordsToBytes(field, false))
  }
  if (paymentHash === undefined) throw new Error('invoice has no payment hash')

  // Signature over sha256(hrp bytes || data words without the signature, padded to bytes).
  const sig = wordsToBytes(sigWords, false)
  const msgHash = Hash.sha256([...Utils.toArray(hrp, 'utf8'), ...wordsToBytes(body, true)])
  const signature = new Signature(new BigNumber(sig.slice(0, 32)), new BigNumber(sig.slice(32, 64)))
  const recovered = signature.RecoverPublicKey(sig[64], new BigNumber(msgHash)).toString()
  if (declaredPayee !== undefined && declaredPayee !== recovered) throw new Error('invoice signature does not match its payee')

  return {
    network,
    amountMsat,
    amountSat: amountMsat === undefined ? undefined : Number(amountMsat / 1000n),
    timestamp,
    expiresAt: timestamp + expiry,
    paymentHash,
    payee: declaredPayee ?? recovered,
    minFinalCltv,
    description
  }
}

/**
 * The donor's check before paying the agent's invoice from any wallet. Returns the problems (empty = safe to pay).
 * `minFinalCltv`: blocks the payment must stay refundable-by-timeout at least (the agreed source window).
 */
export function checkSwapInvoice (invoice: string, want: { paymentHash: string, amountSat: number, payee: string, minFinalCltv: number, network?: LnNetwork, now?: number }): string[] {
  let d: DecodedInvoice
  try { d = decodeInvoice(invoice) } catch (e) { return [(e as Error).message] }
  const now = want.now ?? Math.floor(Date.now() / 1000)
  return [
    d.paymentHash !== want.paymentHash && 'the invoice is for a different payment hash (not your secret)',
    d.amountSat !== want.amountSat && `the invoice asks ${d.amountSat ?? 'any amount of'} sats, not ${want.amountSat}`,
    d.payee !== want.payee && 'the invoice pays a different node than the liquidity agent',
    d.minFinalCltv < want.minFinalCltv && `the invoice's timeout (${d.minFinalCltv} blocks) is shorter than agreed (${want.minFinalCltv})`,
    want.network !== undefined && d.network !== want.network && `the invoice is for ${d.network}, not ${want.network}`,
    d.expiresAt <= now && 'the invoice has expired'
  ].filter((p): p is string => typeof p === 'string')
}
