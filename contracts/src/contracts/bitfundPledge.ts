import {
    assert,
    ByteString,
    FixedArray,
    hash256,
    method,
    prop,
    PubKey,
    Sig,
    SigHash,
    SmartContract,
    toByteString,
} from 'scrypt-ts'

/** Campaigns have at most this many milestones (unused slots repeat 10000). */
export const MAX_MILESTONES = 4

/**
 * BitFundPledge — one escrow UTXO per donation.
 *
 * Each donation is locked in its own instance, so donations never contend for
 * a shared UTXO and micro-donations scale with BSV's parallel UTXO model.
 *
 * Spending paths:
 *  - release:      creator + arbiter (BitFund vote oracle) release the next
 *                  milestone tranche. The covenant forces the unreleased part
 *                  back into this contract (stage + 1) at the same output index.
 *  - refund:       after `refundAfter` the donor alone reclaims whatever is
 *                  still escrowed. Needs nobody's cooperation — not even BitFund.
 *  - refundFailed: donor + arbiter, any time: the oracle attests that the
 *                  campaign missed its goal, so donors need not wait.
 */
export class BitFundPledge extends SmartContract {
    /** sha256 of the campaign's canonical metadata. Binds the pledge to one campaign. */
    @prop()
    campaignId: ByteString

    /** Creator's BRC-42 derived key for this campaign. */
    @prop()
    creator: PubKey

    /** Arbiter (vote oracle) key; signs only when the goal or a donor vote is met. */
    @prop()
    arbiter: PubKey

    /** Donor's BRC-42 derived key for this pledge. */
    @prop()
    donor: PubKey

    /** Satoshis originally pledged (the indexer checks it equals the output value). */
    @prop()
    pledged: bigint

    /** Cumulative release schedule in basis points after milestone i (last used slot = 10000). */
    @prop()
    cumulativeBps: FixedArray<bigint, typeof MAX_MILESTONES>

    /** nLockTime (unix seconds) after which the donor may reclaim the remainder alone. */
    @prop()
    refundAfter: bigint

    /** Number of milestones already released. */
    @prop(true)
    stage: bigint

    constructor(
        campaignId: ByteString,
        creator: PubKey,
        arbiter: PubKey,
        donor: PubKey,
        pledged: bigint,
        cumulativeBps: FixedArray<bigint, typeof MAX_MILESTONES>,
        refundAfter: bigint
    ) {
        super(...arguments)
        this.campaignId = campaignId
        this.creator = creator
        this.arbiter = arbiter
        this.donor = donor
        this.pledged = pledged
        this.cumulativeBps = cumulativeBps
        this.refundAfter = refundAfter
        this.stage = 0n
    }

    /**
     * Release the next milestone tranche to the creator.
     *
     * The preimage is ANYONECANPAY|SINGLE, so many pledges can be released in
     * one transaction: input i's continuation must be output i. The two
     * signatures are SIGHASH_ALL, which commits them to every input and output,
     * so nobody can redirect the released satoshis.
     */
    @method(SigHash.ANYONECANPAY_SINGLE)
    public release(creatorSig: Sig, arbiterSig: Sig) {
        assert(this.checkSig(creatorSig, this.creator), 'creator signature invalid')
        assert(this.checkSig(arbiterSig, this.arbiter), 'arbiter signature invalid')
        assert(this.stage < BigInt(MAX_MILESTONES), 'all milestones released')

        let releasedBps = 0n
        for (let i = 0; i < MAX_MILESTONES; i++) {
            if (this.stage == BigInt(i)) {
                releasedBps = this.cumulativeBps[i]
            }
        }
        const remaining = this.pledged - (this.pledged * releasedBps) / 10000n

        let continuation = toByteString('')
        if (remaining > 0n) {
            this.stage = this.stage + 1n
            continuation = this.buildStateOutput(remaining)
        }
        assert(
            remaining == 0n || hash256(continuation) == this.ctx.hashOutputs,
            'unreleased funds must stay escrowed at the same output index'
        )
    }

    /** After `refundAfter` the donor reclaims the remaining escrow, trustlessly. */
    @method()
    public refund(donorSig: Sig) {
        assert(this.timeLock(this.refundAfter), 'refund deadline not reached')
        assert(this.checkSig(donorSig, this.donor), 'donor signature invalid')
    }

    /** Early refund when the oracle attests the campaign failed. */
    @method()
    public refundFailed(donorSig: Sig, arbiterSig: Sig) {
        assert(this.checkSig(donorSig, this.donor), 'donor signature invalid')
        assert(this.checkSig(arbiterSig, this.arbiter), 'arbiter signature invalid')
    }
}
