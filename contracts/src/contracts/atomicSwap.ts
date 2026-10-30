import { assert, ByteString, len, method, prop, PubKey, sha256, Sha256, Sig, SmartContract } from 'scrypt-ts'

/**
 * AtomicSwap: the BSV half of a cross-chain hash-time-locked swap (HTLC).
 *
 * The same 32-byte secret unlocks both chains' contracts. Whoever claims
 * first reveals it on chain, which lets the other party claim on the other
 * chain. If nobody claims, each side takes its own money back after its
 * timeout. Nobody can ever take the other's funds.
 *
 *  - claim:  the receiver shows the secret (sha256(secret) == hashlock) and
 *            signs. The signature is required so that someone who copies the
 *            secret from the mempool cannot redirect the payment.
 *  - refund: after `refundAfter` (nLockTime via the sighash preimage, like the
 *            escrow's refund) the sender takes the money back.
 */
export class AtomicSwap extends SmartContract {
    /** sha256 of the 32-byte secret (the same hash locks the other chain). */
    @prop()
    hashlock: Sha256

    /** Who receives the sats when the secret is shown (a key derived in their wallet). */
    @prop()
    receiver: PubKey

    /** Who locked the sats and gets them back after the timeout. */
    @prop()
    sender: PubKey

    /** nLockTime (unix seconds) from which the sender may refund. */
    @prop()
    refundAfter: bigint

    constructor(hashlock: Sha256, receiver: PubKey, sender: PubKey, refundAfter: bigint) {
        super(...arguments)
        this.hashlock = hashlock
        this.receiver = receiver
        this.sender = sender
        this.refundAfter = refundAfter
    }

    @method()
    public claim(secret: ByteString, receiverSig: Sig) {
        assert(len(secret) == 32n, 'the secret is 32 bytes')
        assert(sha256(secret) == this.hashlock, 'wrong secret')
        assert(this.checkSig(receiverSig, this.receiver), 'receiver signature invalid')
    }

    @method()
    public refund(senderSig: Sig) {
        assert(this.timeLock(this.refundAfter), 'refund time not reached')
        assert(this.checkSig(senderSig, this.sender), 'sender signature invalid')
    }
}
