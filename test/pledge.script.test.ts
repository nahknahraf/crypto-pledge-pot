/**
 * BitFundPledge at script level: the @bsv/sdk runtime reproduces the sCrypt
 * compiler's output exactly, and every spending path is executed by the SDK's
 * script interpreter (the same engine the mock chain uses to validate).
 */
import { describe, expect, it } from 'vitest'
import { Hash, P2PKH, PrivateKey, Spend, Transaction, TransactionSignature } from '@bsv/sdk'
import fixtures from './fixtures/pledge-scripts.json'
import {
  ALL_SCOPE,
  cumulativeSchedule,
  escrowedAfter,
  parsePledgeScript,
  pledgeLockingScript,
  preimage,
  RELEASE_PREIMAGE_SCOPE,
  refundFailedUnlock,
  refundUnlock,
  releaseUnlock,
  unlockLength,
  type PledgeTerms
} from '../core/pledge'

describe('compiled template', () => {
  it('reproduces the scrypt-ts locking scripts byte for byte', () => {
    for (const f of fixtures) {
      f.stages.forEach((stage, i) => {
        expect(pledgeLockingScript(f.terms as PledgeTerms, stage).toHex()).toBe(f.scripts[i])
      })
    }
  })

  it('parses its own scripts back, including state', () => {
    for (const f of fixtures) {
      f.stages.forEach((stage, i) => {
        expect(parsePledgeScript(f.scripts[i])).toEqual({ ...f.terms, stage })
      })
    }
    expect(parsePledgeScript(new P2PKH().lock(PrivateKey.fromRandom().toAddress()))).toBeUndefined()
    expect(parsePledgeScript(fixtures[0].scripts[0].slice(0, -2) + '01')).toBeUndefined()
  })

  it('builds cumulative schedules', () => {
    expect(cumulativeSchedule([100])).toEqual([10000, 10000, 10000, 10000])
    expect(cumulativeSchedule([25, 25, 50])).toEqual([2500, 5000, 10000, 10000])
    expect(() => cumulativeSchedule([50, 40])).toThrow(/add up to 100/)
    expect(() => cumulativeSchedule([20, 20, 20, 20, 20])).toThrow(/1 to 4/)
    expect(escrowedAfter({ pledged: 1001, cumulativeBps: [2500, 5000, 10000, 10000] }, 1)).toBe(751)
    expect(escrowedAfter({ pledged: 1001, cumulativeBps: [2500, 5000, 10000, 10000] }, 3)).toBe(0)
  })
})

// ── Executing the contract ──────────────────────────────────────────────────

const creatorKey = PrivateKey.fromRandom()
const arbiterKey = PrivateKey.fromRandom()
const donorKey = PrivateKey.fromRandom()
const outsider = PrivateKey.fromRandom()
const REFUND_AFTER = 1_800_000_000

const terms: PledgeTerms = {
  campaignId: Hash.sha256('campaign', 'utf8').map(b => b.toString(16).padStart(2, '0')).join(''),
  creator: creatorKey.toPublicKey().toString(),
  arbiter: arbiterKey.toPublicKey().toString(),
  donor: donorKey.toPublicKey().toString(),
  pledged: 10_000,
  cumulativeBps: cumulativeSchedule([25, 25, 50]),
  refundAfter: REFUND_AFTER
}

/** A confirmed-looking source tx holding the pledge at output 0. */
function sourceTx (stage = 0, satoshis = escrowedAfter(terms, stage)): Transaction {
  const tx = new Transaction()
  tx.addInput({ sourceTXID: '00'.repeat(32), sourceOutputIndex: 0, unlockingScript: new P2PKH().lock(outsider.toAddress()), sequence: 0xffffffff })
  tx.addOutput({ lockingScript: pledgeLockingScript(terms, stage), satoshis })
  return tx
}

function spending (src: Transaction, outputs: Array<{ lockingScript: any, satoshis: number }>, opts: { lockTime?: number, sequence?: number } = {}): Transaction {
  const tx = new Transaction(1, [], [], opts.lockTime ?? 0)
  tx.addInput({ sourceTransaction: src, sourceOutputIndex: 0, sequence: opts.sequence ?? 0xffffffff })
  for (const o of outputs) tx.addOutput(o)
  return tx
}

const sign = (key: PrivateKey, tx: Transaction, scope = ALL_SCOPE): number[] => {
  const sig = key.sign(Hash.sha256(preimage(tx, 0, scope)))
  return new TransactionSignature(sig.r, sig.s, scope).toChecksigFormat()
}

function run (tx: Transaction): boolean {
  const input = tx.inputs[0]
  const src = input.sourceTransaction!.outputs[input.sourceOutputIndex]
  const spend = new Spend({
    sourceTXID: input.sourceTransaction!.id('hex'),
    sourceOutputIndex: input.sourceOutputIndex,
    sourceSatoshis: src.satoshis!,
    lockingScript: src.lockingScript,
    transactionVersion: tx.version,
    otherInputs: tx.inputs.slice(1),
    outputs: tx.outputs,
    inputIndex: 0,
    unlockingScript: input.unlockingScript!,
    inputSequence: input.sequence!,
    lockTime: tx.lockTime
  })
  try { return spend.validate() } catch { return false }
}

const payout = (sats: number) => ({ lockingScript: new P2PKH().lock(creatorKey.toAddress()), satoshis: sats })

function release (src: Transaction, outputs: Array<{ lockingScript: any, satoshis: number }>, signers = { creator: creatorKey, arbiter: arbiterKey }): Transaction {
  const tx = spending(src, outputs)
  tx.inputs[0].unlockingScript = releaseUnlock(sign(signers.creator, tx), sign(signers.arbiter, tx), preimage(tx, 0, RELEASE_PREIMAGE_SCOPE))
  return tx
}

describe('release (creator + arbiter, milestone covenant)', () => {
  it('releases milestone 1 and keeps the remainder escrowed at stage 1', () => {
    const tx = release(sourceTx(0), [{ lockingScript: pledgeLockingScript(terms, 1), satoshis: 7_500 }, payout(2_400)])
    expect(run(tx)).toBe(true)
    expect(tx.inputs[0].unlockingScript!.toBinary().length).toBeLessThanOrEqual(unlockLength.release(pledgeLockingScript(terms).toBinary().length))
  })

  it('walks every milestone to the end; the last one releases everything', () => {
    expect(run(release(sourceTx(1), [{ lockingScript: pledgeLockingScript(terms, 2), satoshis: 5_000 }, payout(2_400)]))).toBe(true)
    expect(run(release(sourceTx(2), [payout(4_900)]))).toBe(true)
  })

  it('refuses to release more than the milestone allows', () => {
    expect(run(release(sourceTx(0), [{ lockingScript: pledgeLockingScript(terms, 1), satoshis: 7_499 }, payout(2_400)]))).toBe(false)
    expect(run(release(sourceTx(0), [payout(9_900)]))).toBe(false)
  })

  it('refuses a continuation that skips a stage or sits at another output index', () => {
    expect(run(release(sourceTx(0), [{ lockingScript: pledgeLockingScript(terms, 2), satoshis: 7_500 }]))).toBe(false)
    expect(run(release(sourceTx(0), [payout(100), { lockingScript: pledgeLockingScript(terms, 1), satoshis: 7_500 }]))).toBe(false)
  })

  it('needs both the creator and the arbiter', () => {
    const cont = [{ lockingScript: pledgeLockingScript(terms, 1), satoshis: 7_500 }]
    expect(run(release(sourceTx(0), cont, { creator: outsider, arbiter: arbiterKey }))).toBe(false)
    expect(run(release(sourceTx(0), cont, { creator: creatorKey, arbiter: outsider }))).toBe(false)
    expect(run(release(sourceTx(0), cont, { creator: creatorKey, arbiter: creatorKey }))).toBe(false)
  })

  it('rejects a forged preimage', () => {
    const tx = spending(sourceTx(0), [{ lockingScript: pledgeLockingScript(terms, 1), satoshis: 7_500 }])
    const other = spending(sourceTx(0), [{ lockingScript: pledgeLockingScript(terms, 1), satoshis: 7_500 }], { lockTime: 5 })
    tx.inputs[0].unlockingScript = releaseUnlock(sign(creatorKey, tx), sign(arbiterKey, tx), preimage(other, 0, RELEASE_PREIMAGE_SCOPE))
    expect(run(tx)).toBe(false)
  })
})

describe('refund (donor alone, after refundAfter)', () => {
  const refundTx = (opts: { lockTime: number, sequence: number }, key = donorKey): Transaction => {
    const tx = spending(sourceTx(1), [{ lockingScript: new P2PKH().lock(donorKey.toAddress()), satoshis: 7_400 }], opts)
    tx.inputs[0].unlockingScript = refundUnlock(sign(key, tx), preimage(tx, 0, ALL_SCOPE))
    return tx
  }

  it('lets the donor reclaim the remaining escrow once nLockTime >= refundAfter', () => {
    expect(run(refundTx({ lockTime: REFUND_AFTER, sequence: 0xfffffffe }))).toBe(true)
  })

  it('refuses before the deadline, with a final sequence, or with a block-height lock time', () => {
    expect(run(refundTx({ lockTime: REFUND_AFTER - 1, sequence: 0xfffffffe }))).toBe(false)
    expect(run(refundTx({ lockTime: REFUND_AFTER, sequence: 0xffffffff }))).toBe(false)
    expect(run(refundTx({ lockTime: 900_000, sequence: 0xfffffffe }))).toBe(false)
  })

  it('refuses anyone but the donor', () => {
    expect(run(refundTx({ lockTime: REFUND_AFTER, sequence: 0xfffffffe }, creatorKey))).toBe(false)
  })
})

describe('refundFailed (donor + arbiter, any time)', () => {
  const tx = (donor: PrivateKey, arbiter: PrivateKey): Transaction => {
    const t = spending(sourceTx(0), [{ lockingScript: new P2PKH().lock(donorKey.toAddress()), satoshis: 9_900 }])
    t.inputs[0].unlockingScript = refundFailedUnlock(sign(donor, t), sign(arbiter, t))
    return t
  }
  it('refunds immediately when the arbiter attests failure', () => {
    expect(run(tx(donorKey, arbiterKey))).toBe(true)
  })
  it('needs both signatures', () => {
    expect(run(tx(donorKey, outsider))).toBe(false)
    expect(run(tx(creatorKey, arbiterKey))).toBe(false)
  })
})
