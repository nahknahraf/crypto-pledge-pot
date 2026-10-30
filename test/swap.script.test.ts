/** AtomicSwap at script level: compiler cross-check, and every path run by the SDK interpreter. */
import { describe, expect, it } from 'vitest'
import { Hash, P2PKH, PrivateKey, Spend, Transaction, TransactionSignature } from '@bsv/sdk'
import fixtures from './fixtures/swap-scripts.json'
import { ALL_SCOPE, preimage } from '../core/pledge'
import { claimUnlock, hashlockOf, newSecret, parseSwapScript, secretFromClaim, swapLockingScript, swapRefundUnlock, swapUnlockLength, type SwapTerms } from '../core/swap'

describe('compiled template', () => {
  it('reproduces the scrypt-ts locking scripts byte for byte and parses them back', () => {
    for (const f of fixtures) {
      expect(swapLockingScript(f.terms as SwapTerms).toHex()).toBe(f.script)
      expect(parseSwapScript(f.script)).toEqual(f.terms)
    }
    expect(parseSwapScript(new P2PKH().lock(PrivateKey.fromRandom().toAddress()))).toBeUndefined()
    expect(parseSwapScript(fixtures[0].script + '00')).toBeUndefined()
  })
  it('makes 32-byte secrets with matching hashlocks', () => {
    const s = newSecret()
    expect(s.secret).toMatch(/^[0-9a-f]{64}$/)
    expect(hashlockOf(s.secret)).toBe(s.hashlock)
  })
})

const receiver = PrivateKey.fromRandom()
const sender = PrivateKey.fromRandom()
const outsider = PrivateKey.fromRandom()
const REFUND_AFTER = 1_800_000_000
const { secret, hashlock } = newSecret()
const terms: SwapTerms = { hashlock, receiver: receiver.toPublicKey().toString(), sender: sender.toPublicKey().toString(), refundAfter: REFUND_AFTER }

const source = (): Transaction => {
  const tx = new Transaction()
  tx.addInput({ sourceTXID: '00'.repeat(32), sourceOutputIndex: 0, unlockingScript: new P2PKH().lock(outsider.toAddress()), sequence: 0xffffffff })
  tx.addOutput({ lockingScript: swapLockingScript(terms), satoshis: 50_000 })
  return tx
}
const spending = (opts: { lockTime?: number, sequence?: number } = {}): Transaction => {
  const tx = new Transaction(1, [], [], opts.lockTime ?? 0)
  tx.addInput({ sourceTransaction: source(), sourceOutputIndex: 0, sequence: opts.sequence ?? 0xffffffff })
  tx.addOutput({ lockingScript: new P2PKH().lock(receiver.toAddress()), satoshis: 49_900 })
  return tx
}
const sign = (key: PrivateKey, tx: Transaction): number[] => {
  const sig = key.sign(Hash.sha256(preimage(tx, 0, ALL_SCOPE)))
  return new TransactionSignature(sig.r, sig.s, ALL_SCOPE).toChecksigFormat()
}
const run = (tx: Transaction): boolean => {
  const input = tx.inputs[0]
  const src = input.sourceTransaction!.outputs[0]
  try {
    return new Spend({
      sourceTXID: input.sourceTransaction!.id('hex'), sourceOutputIndex: 0, sourceSatoshis: src.satoshis!, lockingScript: src.lockingScript,
      transactionVersion: tx.version, otherInputs: [], outputs: tx.outputs, inputIndex: 0, unlockingScript: input.unlockingScript!, inputSequence: input.sequence!, lockTime: tx.lockTime
    }).validate()
  } catch { return false }
}
const claim = (secretHex: string, key: PrivateKey): Transaction => { const tx = spending(); tx.inputs[0].unlockingScript = claimUnlock(secretHex, sign(key, tx)); return tx }
const refund = (key: PrivateKey, lockTime: number, sequence = 0xfffffffe): Transaction => {
  const tx = spending({ lockTime, sequence })
  tx.inputs[0].unlockingScript = swapRefundUnlock(sign(key, tx), preimage(tx, 0, ALL_SCOPE))
  return tx
}

describe('claim: the receiver, with the secret', () => {
  it('works with the right secret and the receiver\'s signature, and reveals the secret', () => {
    const tx = claim(secret, receiver)
    expect(run(tx)).toBe(true)
    expect(secretFromClaim(tx.inputs[0].unlockingScript!)).toBe(secret)
    expect(tx.inputs[0].unlockingScript!.toBinary().length).toBeLessThanOrEqual(swapUnlockLength.claim())
  })
  it('fails with a wrong or short secret, or without the receiver\'s signature (no front-running)', () => {
    expect(run(claim(newSecret().secret, receiver))).toBe(false)
    expect(run(claim(secret.slice(0, 62), receiver))).toBe(false)
    expect(run(claim(secret, outsider))).toBe(false)
    expect(run(claim(secret, sender))).toBe(false)
  })
  it('fails with a secret of 0, 31 or 33 bytes (only the 32-byte preimage works, as on the EVM side)', () => {
    for (const s of ['', secret.slice(0, 62), `${secret}00`]) expect(run(claim(s, receiver)), `${s.length / 2} bytes`).toBe(false)
  })
})

describe('refund: the sender, after the timeout', () => {
  it('works for the sender once nLockTime ≥ refundAfter', () => {
    expect(run(refund(sender, REFUND_AFTER))).toBe(true)
  })
  it('fails too early, for anyone else, or with a final sequence', () => {
    expect(run(refund(sender, REFUND_AFTER - 1))).toBe(false)
    expect(run(refund(receiver, REFUND_AFTER))).toBe(false)
    expect(run(refund(sender, REFUND_AFTER, 0xffffffff))).toBe(false)
  })
})
