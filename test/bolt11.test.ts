/**
 * BOLT 11 decoding against the specification's own example. Real LND invoices are decoded and
 * compared with LND's decoder in bridge.lightning.
 */
import { describe, expect, it } from 'vitest'
import { checkSwapInvoice, decodeInvoice } from '../liquidity-agent/bolt11'

// BOLT 11 "Examples": "Please make a donation of any amount using payment_hash 0001020304050607080900010203040506070809000102030405060708090102 to me @03e7156ae33b0a208d0744199163177e909e80176e55d97a2f221ede0f934dd9ad"
const SPEC = 'lnbc1pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdpl2pkx2ctnv5sxxmmwwd5kgetjypeh2ursdae8g6twvus8g6rfwvs8qun0dfjkxaq9qrsgq357wnc5r2ueh7ck6q93dj32dlqnls087fxdwk8qakdyafkq3yap9us6v52vjjsrvywa6rt52cm9r9zqt8r2t7mlcwspyetp5h2tztugp9lfyql'
const HASH = '0001020304050607080900010203040506070809000102030405060708090102'
const PAYEE = '03e7156ae33b0a208d0744199163177e909e80176e55d97a2f221ede0f934dd9ad'

describe('BOLT 11', () => {
  it('decodes the specification example and recovers the payee from the signature', () => {
    const d = decodeInvoice(SPEC)
    expect(d).toMatchObject({ network: 'main', amountSat: undefined, timestamp: 1496314658, paymentHash: HASH, payee: PAYEE, minFinalCltv: 18, description: 'Please consider supporting this project' })
    expect(decodeInvoice(`lightning:${SPEC.toUpperCase()}`).paymentHash).toBe(HASH)
  })
  it('refuses a corrupted invoice', () => {
    const flipped = SPEC.slice(0, 60) + (SPEC[60] === 'q' ? 'p' : 'q') + SPEC.slice(61)
    expect(() => decodeInvoice(flipped)).toThrow(/checksum/)
    expect(() => decodeInvoice('lnbc1qqqq')).toThrow()
    expect(() => decodeInvoice('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4')).toThrow(/not a Lightning invoice|prefix|short/)
  })
  it('checkSwapInvoice names every mismatch', () => {
    const want = { paymentHash: HASH, amountSat: 10_000, payee: PAYEE, minFinalCltv: 30, now: 1496314658 + 10 }
    expect(checkSwapInvoice(SPEC, want)).toEqual([
      'the invoice asks any amount of sats, not 10000',
      'the invoice\'s timeout (18 blocks) is shorter than agreed (30)'
    ])
    expect(checkSwapInvoice(SPEC, { ...want, paymentHash: 'ff'.repeat(32), payee: '02' + 'aa'.repeat(32), now: 1496314658 + 7200 })).toEqual(expect.arrayContaining([
      'the invoice is for a different payment hash (not your secret)', 'the invoice pays a different node than the liquidity agent', 'the invoice has expired'
    ]))
    expect(checkSwapInvoice('nonsense', want)).toHaveLength(1)
  })
})
