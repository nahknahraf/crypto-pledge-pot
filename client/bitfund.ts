/**
 * BitFund on any BRC-100 wallet (BSV Desktop in the browser, wallet-toolbox on
 * a server or in tests). Private keys never leave the wallet: the app computes
 * sighashes and asks the wallet to sign them with BRC-42 derived keys.
 *
 *   launch()   creator  OP_RETURN campaign anchor → register with the indexer
 *   donate()   donor    escrow output (sCrypt BitFundPledge) + OP_RETURN memo
 *   release()  creator  spend escrows: creator sig + arbiter sig per input,
 *                       remainders re-locked by the covenant, released sats
 *                       land in the creator's wallet as change
 *   refund()   donor    reclaim: alone after refundAfter (nLockTime), or with
 *                       the arbiter's co-signature if the campaign failed
 */
import { Hash, Random, Signature, Transaction, TransactionSignature, Utils, type WalletInterface, type WalletProtocol } from '@bsv/sdk'
import {
  campaignAnchorScript,
  campaignIdOf,
  CREATOR_PROTOCOL,
  DONOR_PROTOCOL,
  PLEDGE_BASKET,
  pledgeMemoScript,
  pledgeScriptFor,
  validateCampaign,
  type CampaignMeta,
  type Milestone,
  type PledgeMemo
} from '../core/campaign'
import {
  ALL_SCOPE,
  escrowedAfter,
  MIN_PLEDGE,
  preimage,
  RELEASE_PREIMAGE_SCOPE,
  refundFailedUnlock,
  refundUnlock,
  releaseUnlock,
  unlockLength,
  cumulativeSchedule
} from '../core/pledge'
import type { PledgeView } from '../core/api'
import type { BitFundApi } from './bitfundApi'

export interface LaunchInput {
  title: string
  description: string
  imageUrl?: string
  goal: number
  deadline: number
  refundAfter: number
  milestones: Milestone[]
  kind?: 'agent'
  agentUrl?: string
}

/** Release at most this many escrows per transaction. */
const RELEASE_BATCH = 25
/** Non-final sequence, required for nLockTime to count. */
const NON_FINAL = 0xfffffffe

const hex = (b: number[] | Uint8Array): string => Utils.toHex(Array.from(b))
const newKeyID = (): string => Utils.toHex(Random(16))
const outpointOf = (tx: Transaction, i: number): string =>
  `${tx.inputs[i].sourceTXID ?? tx.inputs[i].sourceTransaction!.id('hex')}.${tx.inputs[i].sourceOutputIndex}`

export class BitFund {
  private identity?: string

  constructor (readonly wallet: WalletInterface, readonly api: BitFundApi, readonly originator?: string) {}

  async identityKey (): Promise<string> {
    this.identity ??= (await this.wallet.getPublicKey({ identityKey: true }, this.originator)).publicKey
    return this.identity
  }

  private async derivedKey (protocolID: WalletProtocol, keyID: string): Promise<string> {
    return (await this.wallet.getPublicKey({ protocolID, keyID, counterparty: 'self' }, this.originator)).publicKey
  }

  /** SIGHASH_ALL|FORKID signature of input `i` by a derived key, in checksig format. */
  private async signInput (tx: Transaction, i: number, protocolID: WalletProtocol, keyID: string): Promise<number[]> {
    const { signature } = await this.wallet.createSignature({
      hashToDirectlySign: Hash.hash256(preimage(tx, i, ALL_SCOPE)),
      protocolID,
      keyID,
      counterparty: 'self'
    }, this.originator)
    const sig = Signature.fromDER([...signature])
    return new TransactionSignature(sig.r, sig.s, ALL_SCOPE).toChecksigFormat()
  }

  // ── creator ──────────────────────────────────────────────────────────────

  /** Create the campaign: anchor its canonical JSON on chain, then register it. */
  async launch (input: LaunchInput): Promise<{ campaignId: string, anchorTxid: string, meta: CampaignMeta }> {
    const nonce = newKeyID()
    const meta: CampaignMeta = {
      v: 1,
      title: input.title.trim(),
      description: input.description.trim(),
      imageUrl: input.imageUrl?.trim() || undefined,
      goal: input.goal,
      deadline: input.deadline,
      refundAfter: input.refundAfter,
      milestones: input.milestones.map(m => ({ title: m.title.trim(), percent: m.percent })),
      creatorIdentityKey: await this.identityKey(),
      creatorKey: await this.derivedKey(CREATOR_PROTOCOL, nonce),
      arbiterKey: await this.api.arbiterKey(nonce),
      nonce,
      createdAt: Math.floor(Date.now() / 1000),
      kind: input.kind,
      agentUrl: input.agentUrl
    }
    validateCampaign(meta)
    const res = await this.wallet.createAction({
      description: 'Launch BitFund campaign',
      labels: ['bitfund'],
      outputs: [{ lockingScript: campaignAnchorScript(meta).toHex(), satoshis: 0, outputDescription: 'BitFund campaign record' }],
      options: { randomizeOutputs: false, acceptDelayedBroadcast: false }
    }, this.originator)
    if (res.tx === undefined) throw new Error('wallet did not return the anchor transaction')
    const { id, anchorTxid } = await this.api.registerCampaign(meta, hex(res.tx))
    if (id !== campaignIdOf(meta)) throw new Error('indexer returned a different campaign id')
    return { campaignId: id, anchorTxid, meta }
  }

  /**
   * Release the next approved milestone of a campaign. Spends every escrow that
   * is ready (in batches), with the arbiter's co-signature. Returns the txids.
   */
  async release (campaignId: string): Promise<{ milestone: number, txids: string[], released: number }> {
    const { meta } = await this.api.campaign(campaignId)
    const ready = await this.api.releasable(campaignId)
    if (ready.milestone === 0 || ready.pledges.length === 0) throw new Error('nothing to release: no milestone is approved yet')
    const txids: string[] = []
    let released = 0
    for (let i = 0; i < ready.pledges.length; i += RELEASE_BATCH) {
      const batch = ready.pledges.slice(i, i + RELEASE_BATCH)
      const r = await this.releaseBatch(meta, ready.milestone, batch, ready.beef)
      txids.push(r.txid)
      released += r.released
    }
    return { milestone: ready.milestone, txids, released }
  }

  private async releaseBatch (meta: CampaignMeta, milestone: number, pledges: PledgeView[], beefHex: string): Promise<{ txid: string, released: number }> {
    const schedule = cumulativeSchedule(meta.milestones.map(m => m.percent))
    const scriptLen = pledgeScriptFor(meta, pledges[0].donorKey, pledges[0].amount).toBinary().length
    const outputs = pledges.flatMap(p => {
      const remaining = escrowedAfter({ pledged: p.amount, cumulativeBps: schedule }, p.stage + 1)
      return remaining > 0
        ? [{ lockingScript: pledgeScriptFor(meta, p.donorKey, p.amount).toHex(), satoshis: remaining, outputDescription: 'Escrow remainder' }]
        : []
    })
    // Covenant pairing: input i's remainder must be output i. Either every pledge
    // keeps a remainder (same schedule, same stage) or none does.
    if (outputs.length !== 0 && outputs.length !== pledges.length) throw new Error('mixed release stages in one batch')
    const released = pledges.reduce((s, p) => s + escrowedAfter({ pledged: p.amount, cumulativeBps: schedule }, p.stage) -
      escrowedAfter({ pledged: p.amount, cumulativeBps: schedule }, p.stage + 1), 0)

    const created = await this.wallet.createAction({
      description: `Release BitFund milestone ${milestone}`,
      labels: ['bitfund'],
      inputBEEF: Utils.toArray(beefHex, 'hex'),
      inputs: pledges.map(p => ({ outpoint: p.outpoint, unlockingScriptLength: unlockLength.release(scriptLen), inputDescription: 'BitFund escrow' })),
      outputs,
      options: { randomizeOutputs: false, acceptDelayedBroadcast: false }
    }, this.originator)
    const signable = created.signableTransaction
    if (signable === undefined) throw new Error('wallet did not return a signable transaction')
    const tx = Transaction.fromAtomicBEEF(signable.tx)
    if (pledges.some((p, i) => outpointOf(tx, i) !== p.outpoint)) {
      await this.wallet.abortAction({ reference: signable.reference }, this.originator)
      throw new Error('wallet reordered the escrow inputs; aborted (the covenant pairs input i with output i)')
    }

    const arbiterSigs = await this.api.releaseSignatures(campaignIdOf(meta), hex(signable.tx))
    const spends: Record<number, { unlockingScript: string }> = {}
    for (let i = 0; i < pledges.length; i++) {
      if (arbiterSigs[i] === undefined) throw new Error(`arbiter did not sign input ${i}`)
      const creatorSig = await this.signInput(tx, i, CREATOR_PROTOCOL, meta.nonce)
      spends[i] = { unlockingScript: releaseUnlock(creatorSig, Utils.toArray(arbiterSigs[i], 'hex'), preimage(tx, i, RELEASE_PREIMAGE_SCOPE)).toHex() }
    }
    const signed = await this.wallet.signAction({ reference: signable.reference, spends, options: { acceptDelayedBroadcast: false } }, this.originator)
    if (signed.tx === undefined || signed.txid === undefined) throw new Error('wallet did not complete the release')
    await this.api.reportSpend(hex(signed.tx))
    return { txid: signed.txid, released }
  }

  /** Post a progress report for milestone k (opens the donor vote). */
  async postUpdate (campaignId: string, milestone: number, note: string): Promise<void> {
    await this.api.postUpdate(campaignId, milestone, note)
  }

  // ── donor ────────────────────────────────────────────────────────────────

  /** Pledge `satoshis` into a fresh escrow, with an on-chain memo. */
  async donate (meta: CampaignMeta, satoshis: number, memo: PledgeMemo = {}): Promise<PledgeView> {
    if (!Number.isSafeInteger(satoshis) || satoshis < MIN_PLEDGE) throw new Error(`donate at least ${MIN_PLEDGE} satoshis`)
    const campaignId = campaignIdOf(meta)
    const keyID = newKeyID()
    const donorKey = await this.derivedKey(DONOR_PROTOCOL, keyID)
    const lockingScript = pledgeScriptFor(meta, donorKey, satoshis).toHex()
    const res = await this.wallet.createAction({
      description: `Pledge to ${meta.title}`.slice(0, 50).padEnd(5, '.'),
      labels: ['bitfund'],
      outputs: [
        {
          lockingScript,
          satoshis,
          outputDescription: 'BitFund escrow pledge',
          basket: PLEDGE_BASKET,
          customInstructions: JSON.stringify({ protocolID: DONOR_PROTOCOL, keyID, counterparty: 'self', campaignId }),
          tags: ['bitfund', `campaign:${campaignId}`]
        },
        { lockingScript: pledgeMemoScript(campaignId, memo).toHex(), satoshis: 0, outputDescription: 'BitFund donation memo' }
      ],
      options: { randomizeOutputs: false, acceptDelayedBroadcast: false }
    }, this.originator)
    if (res.tx === undefined) throw new Error('wallet did not return the donation transaction')
    const outputIndex = Transaction.fromAtomicBEEF(res.tx).outputs.findIndex(o => o.lockingScript.toHex() === lockingScript)
    return await this.api.registerPledge(hex(res.tx), outputIndex, keyID)
  }

  async vote (campaignId: string, milestone: number, approve: boolean): Promise<void> {
    await this.api.vote(campaignId, milestone, approve)
  }

  /**
   * Reclaim a pledge's remaining escrow into this wallet.
   *  - 'deadline': after refundAfter, signed by the donor alone (needs no BitFund approval).
   *  - 'failed':   any time once the campaign failed, co-signed by the arbiter.
   * Default: 'deadline' if refundAfter has passed, otherwise 'failed'.
   */
  async refund (pledgeId: string, mode?: 'deadline' | 'failed', now = Math.floor(Date.now() / 1000)): Promise<{ txid: string, satoshis: number }> {
    const { pledge, beef } = await this.api.pledge(pledgeId)
    if (pledge.status !== 'active') throw new Error(`pledge is ${pledge.status}`)
    const { meta } = await this.api.campaign(pledge.campaignId)
    if (await this.derivedKey(DONOR_PROTOCOL, pledge.donorKeyId) !== pledge.donorKey) throw new Error('this pledge was not made from this wallet')
    const path = mode ?? (now >= meta.refundAfter ? 'deadline' : 'failed')
    const scriptLen = pledgeScriptFor(meta, pledge.donorKey, pledge.amount).toBinary().length

    const created = await this.wallet.createAction({
      description: 'Reclaim BitFund pledge',
      labels: ['bitfund'],
      inputBEEF: Utils.toArray(beef, 'hex'),
      inputs: [{
        outpoint: pledge.outpoint,
        unlockingScriptLength: path === 'deadline' ? unlockLength.refund(scriptLen) : unlockLength.refundFailed(),
        inputDescription: 'BitFund escrow',
        sequenceNumber: path === 'deadline' ? NON_FINAL : undefined
      }],
      outputs: [],
      lockTime: path === 'deadline' ? meta.refundAfter : undefined,
      options: { randomizeOutputs: false, acceptDelayedBroadcast: false }
    }, this.originator)
    const signable = created.signableTransaction
    if (signable === undefined) throw new Error('wallet did not return a signable transaction')
    const tx = Transaction.fromAtomicBEEF(signable.tx)
    const i = tx.inputs.findIndex((_, k) => outpointOf(tx, k) === pledge.outpoint)
    if (i < 0) {
      await this.wallet.abortAction({ reference: signable.reference }, this.originator)
      throw new Error('escrow input missing from the refund transaction')
    }
    const donorSig = await this.signInput(tx, i, DONOR_PROTOCOL, pledge.donorKeyId)
    let unlockingScript: string
    if (path === 'deadline') {
      unlockingScript = refundUnlock(donorSig, preimage(tx, i, ALL_SCOPE)).toHex()
    } else {
      let arbiter: { inputIndex: number, signature: string }
      try {
        arbiter = await this.api.refundSignature(pledge.id, hex(signable.tx))
      } catch (e) {
        await this.wallet.abortAction({ reference: signable.reference }, this.originator)
        throw e
      }
      unlockingScript = refundFailedUnlock(donorSig, Utils.toArray(arbiter.signature, 'hex')).toHex()
    }
    const signed = await this.wallet.signAction({ reference: signable.reference, spends: { [i]: { unlockingScript } }, options: { acceptDelayedBroadcast: false } }, this.originator)
    if (signed.tx === undefined || signed.txid === undefined) throw new Error('wallet did not complete the refund')
    await this.api.reportSpend(hex(signed.tx))
    return { txid: signed.txid, satoshis: pledge.escrowed }
  }
}
