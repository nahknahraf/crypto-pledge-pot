/**
 * CryptoPledgePot on any BRC-100 wallet (BSV Desktop in the browser, wallet-toolbox on
 * a server or in tests). Private keys never leave the wallet: the app computes
 * sighashes and asks the wallet to sign them with BRC-42 derived keys.
 *
 *   launch()   creator  OP_RETURN campaign anchor → register with the indexer
 *   donate()   donor    escrow output (sCrypt CryptoPledgePotEscrow) + OP_RETURN memo
 *   release()  creator  spend escrows: creator sig + arbiter sig per input,
 *                       remainders re-locked by the covenant, released sats
 *                       land in the creator's wallet as change
 *   refund()   donor    reclaim: alone after refundAfter (nLockTime), or with
 *                       the arbiter's co-signature if the campaign failed
 *   payPlanLine() / reportSpending()
 *              creator  pay a payment-plan budget line and prove it (SPV), or
 *                       report an auditor-signed off-chain invoice
 *   repay()    creator  pay a non-compliant milestone's unaccounted sats back
 *                       to the donors, pro rata (P2PKH of each donor key)
 *   claimRepayments()
 *              donor    collect those repayments into this wallet
 */
import { Beef, Hash, PublicKey, Random, Script, Signature, Transaction, TransactionSignature, Utils, type WalletInterface, type WalletProtocol } from '@bsv/sdk'
import {
  campaignAnchorScript,
  campaignIdOf,
  claimMessage,
  CREATOR_PROTOCOL,
  DONOR_PROTOCOL,
  PLEDGE_BASKET,
  PROTOCOL_TAGS,
  protocolsFor,
  type ProtocolTag,
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
  cumulativeSchedule,
  parsePledgeScript
} from '../core/pledge'
import { lineOf, PAYMENT_PLAN_PROTOCOL, paymentPlanHash, type PaymentPlan, type SpendClaim, type SpendingResult } from '../core/paymentPlan'
import type { PledgeView } from '../core/api'
import type { CryptoPledgePotApi } from './cryptoPledgePotApi'

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
  /** NGO payment plan: signed by this wallet and fixed into the campaign id. */
  paymentPlan?: PaymentPlan
}

/** Release at most this many escrows per transaction. */
const RELEASE_BATCH = 25
/** Non-final sequence, required for nLockTime to count. */
const NON_FINAL = 0xfffffffe

const hex = (b: number[] | Uint8Array): string => Utils.toHex(Array.from(b))
const newKeyID = (): string => Utils.toHex(Random(16))
const outpointOf = (tx: Transaction, i: number): string =>
  `${tx.inputs[i].sourceTXID ?? tx.inputs[i].sourceTransaction!.id('hex')}.${tx.inputs[i].sourceOutputIndex}`

export class CryptoPledgePot {
  private identity?: string

  constructor (readonly wallet: WalletInterface, readonly api: CryptoPledgePotApi, readonly originator?: string) {}

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
    if (input.paymentPlan !== undefined) {
      const { signature } = await this.wallet.createSignature({
        hashToDirectlySign: paymentPlanHash(input.paymentPlan),
        protocolID: PAYMENT_PLAN_PROTOCOL,
        keyID: nonce,
        counterparty: 'anyone'
      }, this.originator)
      meta.paymentPlan = input.paymentPlan
      meta.paymentPlanSignature = hex(signature)
    }
    validateCampaign(meta)
    const res = await this.wallet.createAction({
      description: 'Launch CryptoPledgePot campaign',
      labels: ['cryptopledgepot'],
      outputs: [{ lockingScript: campaignAnchorScript(meta).toHex(), satoshis: 0, outputDescription: 'CryptoPledgePot campaign record' }],
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
    const { meta, protocolTag } = await this.api.campaign(campaignId)
    const ready = await this.api.releasable(campaignId)
    if (ready.milestone === 0 || ready.pledges.length === 0) throw new Error('nothing to release: no milestone is approved yet')
    const txids: string[] = []
    let released = 0
    for (let i = 0; i < ready.pledges.length; i += RELEASE_BATCH) {
      const batch = ready.pledges.slice(i, i + RELEASE_BATCH)
      const r = await this.releaseBatch(meta, ready.milestone, batch, ready.beef, protocolTag ?? 'cryptopledgepot')
      txids.push(r.txid)
      released += r.released
    }
    return { milestone: ready.milestone, txids, released }
  }

  private async releaseBatch (meta: CampaignMeta, milestone: number, pledges: PledgeView[], beefHex: string, tag: ProtocolTag): Promise<{ txid: string, released: number }> {
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
      description: `Release CryptoPledgePot milestone ${milestone}`,
      labels: ['cryptopledgepot'],
      inputBEEF: Utils.toArray(beefHex, 'hex'),
      inputs: pledges.map(p => ({ outpoint: p.outpoint, unlockingScriptLength: unlockLength.release(scriptLen), inputDescription: 'CryptoPledgePot escrow' })),
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
      const creatorSig = await this.signInput(tx, i, protocolsFor(tag).creator, meta.nonce)
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

  /**
   * Pay a budget line of the payment plan to its on-chain payee from this
   * wallet, and report the payment (the server checks it by SPV).
   */
  async payPlanLine (campaignId: string, milestone: number, lineId: string, satoshis: number, note?: string): Promise<{ txid: string, spending: SpendingResult }> {
    const { meta } = await this.api.campaign(campaignId)
    const line = meta.paymentPlan !== undefined ? lineOf(meta.paymentPlan, milestone, lineId) : undefined
    if (line === undefined) throw new Error(`no budget line "${lineId}" in milestone ${milestone}`)
    const payee = line.payee
    if (payee.kind !== 'onchain') throw new Error(`${payee.name} is paid off chain: report the auditor-signed invoice with reportSpending()`)
    const res = await this.wallet.createAction({
      description: `Pay ${payee.name}`.slice(0, 50).padEnd(5, '.'),
      labels: ['cryptopledgepot', 'payment plan'],
      outputs: [{ lockingScript: payee.lockingScript, satoshis, outputDescription: `${line.category}`.slice(0, 50).padEnd(5, '.') }],
      options: { randomizeOutputs: false, acceptDelayedBroadcast: false }
    }, this.originator)
    if (res.tx === undefined || res.txid === undefined) throw new Error('wallet did not return the payment transaction')
    const vout = Transaction.fromAtomicBEEF(res.tx).outputs.findIndex(o => o.lockingScript.toHex() === payee.lockingScript && o.satoshis === satoshis)
    const spending = await this.reportSpending(campaignId, milestone, [{ lineId, beef: hex(res.tx), vout, note }])
    return { txid: res.txid, spending }
  }

  /** Report expenses against the payment plan: on-chain payments (AtomicBEEF + vout) or auditor-signed invoices. */
  async reportSpending (campaignId: string, milestone: number, claims: Array<SpendClaim & { beef?: string }>): Promise<SpendingResult> {
    return await this.api.reportSpending(campaignId, milestone, claims)
  }

  /** Pay back what the payment plan says is owed for milestone k, to every donor's key in one transaction. */
  async repay (campaignId: string, milestone: number): Promise<{ txid: string, sats: number }> {
    const plan = await this.api.repaymentPlan(campaignId, milestone)
    if (plan.outstanding.length === 0) throw new Error(`nothing is owed for milestone ${milestone} (${plan.state})`)
    const res = await this.wallet.createAction({
      description: `Repay donors, milestone ${milestone}`,
      labels: ['cryptopledgepot', 'payment plan'],
      outputs: plan.outstanding.map(o => ({ lockingScript: o.lockingScript, satoshis: o.sats, outputDescription: 'Repayment to a donor' })),
      options: { randomizeOutputs: false, acceptDelayedBroadcast: false }
    }, this.originator)
    if (res.tx === undefined) throw new Error('wallet did not return the repayment transaction')
    return await this.api.reportRepayment(campaignId, milestone, hex(res.tx))
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
      labels: ['cryptopledgepot'],
      outputs: [
        {
          lockingScript,
          satoshis,
          outputDescription: 'CryptoPledgePot escrow pledge',
          basket: PLEDGE_BASKET,
          customInstructions: JSON.stringify({ protocolID: DONOR_PROTOCOL, keyID, counterparty: 'self', campaignId }),
          tags: ['cryptopledgepot', `campaign:${campaignId}`]
        },
        { lockingScript: pledgeMemoScript(campaignId, memo).toHex(), satoshis: 0, outputDescription: 'CryptoPledgePot donation memo' }
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
   * Collect every repayment owed to this wallet's pledges (an NGO paying back
   * a non-compliant milestone) in one transaction, into this wallet.
   */
  async claimRepayments (): Promise<{ txid: string, satoshis: number, outpoints: string[] } | undefined> {
    const owed = await this.api.donorRepayments(await this.identityKey())
    if (owed.length === 0) return undefined
    const beef = new Beef()
    const keys: Array<{ keyID: string, protocol: WalletProtocol, pub: number[] }> = []
    for (const r of owed) {
      beef.mergeBeef(Utils.toArray(r.beef, 'hex'))
      const tag = (await this.api.campaign(r.campaignId)).protocolTag ?? 'cryptopledgepot'
      const keyID = r.donorKeyId !== '' ? r.donorKeyId : (await this.findDonorKey(r.donorKey))?.keyID
      if (keyID === undefined || await this.derivedKey(protocolsFor(tag).donor, keyID) !== r.donorKey) throw new Error(`pledge ${r.pledgeId} was not made from this wallet`)
      keys.push({ keyID, protocol: protocolsFor(tag).donor, pub: PublicKey.fromString(r.donorKey).encode(true) as number[] })
    }
    const created = await this.wallet.createAction({
      description: 'Collect CryptoPledgePot repayments',
      labels: ['cryptopledgepot'],
      inputBEEF: beef.toBinary(),
      inputs: owed.map(r => ({ outpoint: r.outpoint, unlockingScriptLength: 108, inputDescription: 'Repayment from a campaign' })),
      outputs: [],
      options: { randomizeOutputs: false, acceptDelayedBroadcast: false }
    }, this.originator)
    const signable = created.signableTransaction
    if (signable === undefined) throw new Error('wallet did not return a signable transaction')
    const tx = Transaction.fromAtomicBEEF(signable.tx)
    const spends: Record<number, { unlockingScript: string }> = {}
    for (let j = 0; j < owed.length; j++) {
      const i = tx.inputs.findIndex((_, k) => outpointOf(tx, k) === owed[j].outpoint)
      if (i < 0) { await this.wallet.abortAction({ reference: signable.reference }, this.originator); throw new Error('repayment input missing') }
      const sig = await this.signInput(tx, i, keys[j].protocol, keys[j].keyID)
      spends[i] = { unlockingScript: new Script().writeBin(sig).writeBin(keys[j].pub).toHex() }
    }
    const signed = await this.wallet.signAction({ reference: signable.reference, spends, options: { acceptDelayedBroadcast: false } }, this.originator)
    if (signed.tx === undefined || signed.txid === undefined) throw new Error('wallet did not complete the collection')
    await this.api.reportRepaymentsClaimed(hex(signed.tx))
    return { txid: signed.txid, satoshis: owed.reduce((s, r) => s + r.sats, 0), outpoints: owed.map(r => r.outpoint) }
  }

  // ── recovery: claiming, finding keys, reclaiming without the server ─────

  /** Donor keyID for an escrow, found in this wallet's pledge baskets (current and legacy names). */
  async findDonorKey (donorKey: string, outpoint?: string): Promise<{ keyID: string, tag: ProtocolTag } | undefined> {
    for (const tag of PROTOCOL_TAGS) {
      const { outputs } = await this.wallet.listOutputs({ basket: protocolsFor(tag).basket, includeCustomInstructions: true, limit: 1000 }, this.originator)
      // Exact outpoint first, then any basket entry whose key derives to this donor key
      // (an escrow moves to a new outpoint with every milestone release).
      const ordered = [...outputs.filter(o => o.outpoint === outpoint), ...outputs.filter(o => o.outpoint !== outpoint)]
      for (const o of ordered) {
        let keyID: string | undefined
        try { keyID = JSON.parse(o.customInstructions ?? '{}').keyID } catch { continue }
        if (typeof keyID !== 'string') continue
        if (await this.derivedKey(protocolsFor(tag).donor, keyID) === donorKey) return { keyID, tag }
      }
    }
    return undefined
  }

  /** Prove control of a pledge's donor key and attach it to this identity (for imported pledges). */
  async claim (pledgeId: string): Promise<void> {
    const { pledge } = await this.api.pledge(pledgeId)
    const found = await this.findDonorKey(pledge.donorKey, pledge.id)
    if (found === undefined) throw new Error('this wallet does not hold the donor key of that pledge')
    const message = claimMessage(pledge.id, await this.identityKey())
    const { signature } = await this.wallet.createSignature({
      hashToDirectlySign: Hash.sha256(message, 'utf8'),
      protocolID: protocolsFor(found.tag).donor,
      keyID: found.keyID,
      counterparty: 'self'
    }, this.originator)
    await this.api.claimPledge(pledge.id, found.keyID, hex(signature))
  }

  /** Claim every unclaimed indexed pledge whose escrow this wallet made (e.g. after an import from chain). */
  async claimWalletPledges (): Promise<string[]> {
    const claimed: string[] = []
    for (const tag of PROTOCOL_TAGS) {
      const { outputs } = await this.wallet.listOutputs({ basket: protocolsFor(tag).basket, limit: 1000 }, this.originator)
      for (const o of outputs) {
        try {
          const { pledge } = await this.api.pledge(o.outpoint)
          if (pledge.donorIdentity !== '') continue
          await this.claim(pledge.id)
          claimed.push(pledge.id)
        } catch { /* not indexed here, or not ours */ }
      }
    }
    return claimed
  }

  /**
   * Reclaim a pledge's remaining escrow into this wallet.
   *  - 'deadline': after refundAfter, signed by the donor alone (needs no CryptoPledgePot approval).
   *  - 'failed':   any time once the campaign failed, co-signed by the arbiter.
   * Default: 'deadline' if refundAfter has passed, otherwise 'failed'.
   */
  async refund (pledgeId: string, mode?: 'deadline' | 'failed', now = Math.floor(Date.now() / 1000)): Promise<{ txid: string, satoshis: number }> {
    let { pledge, beef } = await this.api.pledge(pledgeId)
    if (pledge.status !== 'active') throw new Error(`pledge is ${pledge.status}`)
    const { meta, protocolTag } = await this.api.campaign(pledge.campaignId)
    const path = mode ?? (now >= meta.refundAfter ? 'deadline' : 'failed')
    // Imported pledges have no keyID on the server yet; the arbiter also needs to know who we are.
    if (pledge.donorKeyId === '' || (path === 'failed' && pledge.donorIdentity === '')) {
      await this.claim(pledge.id)
      ;({ pledge, beef } = await this.api.pledge(pledgeId))
    }
    const donorProtocol = protocolsFor(protocolTag ?? 'cryptopledgepot').donor
    if (await this.derivedKey(donorProtocol, pledge.donorKeyId) !== pledge.donorKey) throw new Error('this pledge was not made from this wallet')
    const r = await this.spendEscrowRefund({
      outpoint: pledge.outpoint,
      beefHex: beef,
      scriptLen: pledgeScriptFor(meta, pledge.donorKey, pledge.amount).toBinary().length,
      keyID: pledge.donorKeyId,
      donorProtocol,
      path,
      refundAfter: meta.refundAfter,
      arbiterSignature: async (signableHex) => await this.api.refundSignature(pledge.id, signableHex)
    })
    await this.api.reportSpend(r.beefHex)
    return { txid: r.txid, satoshis: pledge.escrowed }
  }

  /**
   * Reclaim ANY escrow made from this wallet, given only its current outpoint,
   * without CryptoPledgePot's server: terms are read from the escrow script on
   * chain, the donor key is found in this wallet's baskets (current or legacy
   * names), and the transaction uses the donor-only timelock path. Works only
   * once the escrow's refund date has passed.
   */
  async reclaimEscrow (outpoint: string, opts: { fetchBeef?: (txid: string) => Promise<string>, now?: number, reportTo?: CryptoPledgePotApi } = {}): Promise<{ txid: string, satoshis: number }> {
    const [txid, voutText] = outpoint.split('.')
    const vout = Number(voutText)
    if (!/^[0-9a-f]{64}$/i.test(txid) || !Number.isInteger(vout)) throw new Error('outpoint must look like <txid>.<vout>')
    const beefHex = await (opts.fetchBeef ?? (async (id: string) => await wocBeef(id, (await this.wallet.getNetwork({}, this.originator)).network)))(txid)
    const raw = Utils.toArray(beefHex, 'hex')
    let source: Transaction
    try { source = Transaction.fromAtomicBEEF(raw) } catch { source = Transaction.fromBEEF(raw, txid) }
    const out = source.outputs[vout]
    const terms = out !== undefined ? parsePledgeScript(out.lockingScript) : undefined
    if (out === undefined || terms === undefined) throw new Error('that output is not a CryptoPledgePot escrow')
    const now = opts.now ?? Math.floor(Date.now() / 1000)
    if (now < terms.refundAfter) throw new Error(`this escrow can be reclaimed alone from ${new Date(terms.refundAfter * 1000).toISOString()}`)
    const found = await this.findDonorKey(terms.donor, outpoint)
    if (found === undefined) throw new Error('this wallet does not hold the donor key of that escrow')
    const r = await this.spendEscrowRefund({
      outpoint,
      beefHex: Utils.toHex(Array.from(source.toAtomicBEEF())),
      scriptLen: out.lockingScript.toBinary().length,
      keyID: found.keyID,
      donorProtocol: protocolsFor(found.tag).donor,
      path: 'deadline',
      refundAfter: terms.refundAfter
    })
    if (opts.reportTo !== undefined) await opts.reportTo.reportSpend(r.beefHex).catch(() => undefined)
    return { txid: r.txid, satoshis: out.satoshis! }
  }

  /** Build, sign and broadcast a refund of one escrow (donor-only timelock path, or arbiter-assisted). */
  private async spendEscrowRefund (a: {
    outpoint: string
    beefHex: string
    scriptLen: number
    keyID: string
    donorProtocol: WalletProtocol
    path: 'deadline' | 'failed'
    refundAfter: number
    arbiterSignature?: (signableHex: string) => Promise<{ signature: string }>
  }): Promise<{ txid: string, beefHex: string }> {
    const created = await this.wallet.createAction({
      description: 'Reclaim CryptoPledgePot pledge',
      labels: ['cryptopledgepot'],
      inputBEEF: Utils.toArray(a.beefHex, 'hex'),
      inputs: [{
        outpoint: a.outpoint,
        unlockingScriptLength: a.path === 'deadline' ? unlockLength.refund(a.scriptLen) : unlockLength.refundFailed(),
        inputDescription: 'CryptoPledgePot escrow',
        sequenceNumber: a.path === 'deadline' ? NON_FINAL : undefined
      }],
      outputs: [],
      lockTime: a.path === 'deadline' ? a.refundAfter : undefined,
      options: { randomizeOutputs: false, acceptDelayedBroadcast: false }
    }, this.originator)
    const signable = created.signableTransaction
    if (signable === undefined) throw new Error('wallet did not return a signable transaction')
    const tx = Transaction.fromAtomicBEEF(signable.tx)
    const i = tx.inputs.findIndex((_, k) => outpointOf(tx, k) === a.outpoint)
    if (i < 0) {
      await this.wallet.abortAction({ reference: signable.reference }, this.originator)
      throw new Error('escrow input missing from the refund transaction')
    }
    const donorSig = await this.signInput(tx, i, a.donorProtocol, a.keyID)
    let unlockingScript: string
    if (a.path === 'deadline') {
      unlockingScript = refundUnlock(donorSig, preimage(tx, i, ALL_SCOPE)).toHex()
    } else {
      if (a.arbiterSignature === undefined) throw new Error('an early refund needs the arbiter')
      let arbiter: { signature: string }
      try {
        arbiter = await a.arbiterSignature(hex(signable.tx))
      } catch (e) {
        await this.wallet.abortAction({ reference: signable.reference }, this.originator)
        throw e
      }
      unlockingScript = refundFailedUnlock(donorSig, Utils.toArray(arbiter.signature, 'hex')).toHex()
    }
    const signed = await this.wallet.signAction({ reference: signable.reference, spends: { [i]: { unlockingScript } }, options: { acceptDelayedBroadcast: false } }, this.originator)
    if (signed.tx === undefined || signed.txid === undefined) throw new Error('wallet did not complete the refund')
    return { txid: signed.txid, beefHex: hex(signed.tx) }
  }
}

/** A transaction with its proof chain from WhatsOnChain (BEEF hex). */
export async function wocBeef (txid: string, network: string): Promise<string> {
  const net = network === 'testnet' || network === 'test' ? 'test' : 'main'
  const res = await fetch(`https://api.whatsonchain.com/v1/bsv/${net}/tx/${txid}/beef`)
  if (!res.ok) throw new Error(`WhatsOnChain has no BEEF for ${txid} (HTTP ${res.status})`)
  return (await res.text()).trim().replace(/"/g, '')
}
