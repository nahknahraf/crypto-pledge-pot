/**
 * The liquidity agent: a market maker that swaps USDC (other chain) for BSV
 * sats, without ever holding a user's funds.
 *
 *  1. quote(): a price for an amount, within its limits (max size, inventory).
 *  2. acceptSourceLock(): BEFORE locking any sats it checks the donor's USDC
 *     lock on the other chain (pays the agent, right amount, enough time).
 *     Then it locks sats in an AtomicSwap that pays the DONOR's key, with a
 *     shorter timeout (T2 = T1 − margin), so the donor can always claim first.
 *  3. step(): watches each open swap. When the donor claims the sats, the
 *     claim reveals the secret on BSV; the agent reads it and collects the
 *     USDC. If the donor never claims, it refunds its own sats after T2.
 *
 * Every check is in code; nothing a counterparty says is trusted without
 * looking at the chain.
 */
import type { WalletInterface } from '@bsv/sdk'
import { memoryStore, type Store } from '../agent/ledger'
import { secretFromClaim, type SwapTerms } from '../core/swap'
import { findLock, lockSats, newSwapKey, refundSats, type BsvLock, type SpendFinder } from './bsv'
import { assetOf, formatAmount, unitOf, USDC, type SourceAccount, type SourceChain } from './usdcChain'

export interface LiquidityConfig {
  /** Sats per 1 USDC that the agent pays (its price, spread included). */
  satsPerUsdc: number
  /** Largest swap it accepts, micro-USDC. */
  maxUsdc: number
  /** Keep at least this many sats for fees. */
  feeReserve: number
  /** A quote is valid this long (seconds). */
  quoteValidity: number
  /** The donor's USDC lock must run at least this long (seconds) from now. */
  minSourceWindow: number
  /** Our BSV timeout ends this long before the donor's (seconds): the donor's time to claim safely. */
  safetyMargin: number
  /** Confirmations the donor's source lock needs before we lock sats (a reorg could undo a fresher one). */
  minSourceConfirmations: number
}

export const DEFAULT_LIQUIDITY: LiquidityConfig = { satsPerUsdc: 21_500, maxUsdc: 500 * USDC, feeReserve: 5_000, quoteValidity: 120, minSourceWindow: 4 * 3600, safetyMargin: 2 * 3600, minSourceConfirmations: 1 }

export interface Quote {
  id: string
  usdc: number
  sats: number
  /** Where the donor locks USDC (the agent's address on the other chain). */
  lpAddress: string
  /** The donor's BSV key that the sats will pay. */
  donorBsvKey: string
  expiresAt: number
  /** The donor's USDC lock must not refund before this. */
  minSourceRefundAfter: number
}

/** One swap as the liquidity agent records it. Plain JSON, so it can be persisted. */
export interface LpSwap {
  quote: Quote
  sourceHtlcId?: string
  lock?: BsvLock
  senderKeyID?: string
  /** 'locking': we are about to broadcast (or did, then crashed) the BSV lock described by `pending`. */
  state: 'quoted' | 'locking' | 'locked' | 'settled' | 'refunded' | 'rejected'
  pending?: { terms: SwapTerms, satoshis: number }
  note?: string
}

/**
 * What a donor needs from a liquidity provider. LiquidityAgent implements it
 * in-process; LiquidityClient (lpClient.ts) implements it over HTTP. The donor
 * never trusts the answers: DonorSwap re-checks every lock on chain.
 */
export interface LiquidityProvider {
  quote: (usdc: number, donorBsvKey: string) => Promise<Quote>
  acceptSourceLock: (quoteId: string, sourceHtlcId: string) => Promise<BsvLock>
  /** The BSV lock made for a quote, if any: for a donor whose acceptSourceLock reply was lost. */
  lockFor?: (quoteId: string) => Promise<BsvLock | undefined>
  /** Sources where the agent acts first (Lightning): the payment request for a quote and the donor's hashlock. */
  sourceRequest?: (quoteId: string, hashlock: string, refundAfter: number) => Promise<string>
}

export class LiquidityAgent implements LiquidityProvider {
  private readonly swaps = new Map<string, LpSwap>()
  private readonly usdc: SourceAccount
  readonly log: string[] = []

  /**
   * `store` keeps the swaps across restarts (use fileStore in a real process): after a crash the
   * agent must still collect the USDC for sats it already locked, or refund them.
   */
  /** An amount on the source chain, with its unit ("20.00 USDC", "0.00050000 BTC"). */
  private fmt (n: number): string { return formatAmount(this.source, n) }
  private get sym (): string { return assetOf(this.source).symbol }

  constructor (
    readonly wallet: WalletInterface,
    readonly source: SourceChain,
    lpAddress: string,
    readonly findSpend: SpendFinder,
    readonly spendable: () => Promise<number>,
    readonly config: LiquidityConfig = DEFAULT_LIQUIDITY,
    private readonly store: Store<LpSwap[]> = memoryStore<LpSwap[]>([])
  ) {
    this.usdc = source.account(lpAddress)
    for (const s of store.load()) this.swaps.set(s.quote.id, s)
  }

  private say (line: string): void { this.log.push(line) }
  private persist (): void { this.store.save([...this.swaps.values()]) }
  get address (): string { return this.usdc.address }
  /** Every swap, newest last (for the status page). */
  all (): LpSwap[] { return [...this.swaps.values()].map(s => structuredClone(s)) }

  async quote (usdc: number, donorBsvKey: string): Promise<Quote> {
    if (!Number.isSafeInteger(usdc) || usdc <= 0) throw new Error('amount must be positive')
    if (usdc > this.config.maxUsdc) throw new Error(`above this agent's limit of ${this.fmt(this.config.maxUsdc)}`)
    if (!/^0[23][0-9a-f]{64}$/.test(donorBsvKey)) throw new Error('donor key must be a compressed public key')
    const sats = Math.floor((usdc / unitOf(this.source)) * this.config.satsPerUsdc)
    const openExposure = [...this.swaps.values()].filter(s => s.state === 'quoted' || s.state === 'locking' || s.state === 'locked').reduce((t, s) => t + s.quote.sats, 0)
    if ((await this.spendable()) - openExposure - sats < this.config.feeReserve) throw new Error('not enough BSV inventory for this swap right now')
    const now = await this.source.now()
    const q: Quote = { id: `q${this.swaps.size + 1}`, usdc, sats, lpAddress: this.usdc.address, donorBsvKey, expiresAt: now + this.config.quoteValidity, minSourceRefundAfter: now + this.config.minSourceWindow }
    this.swaps.set(q.id, { quote: q, state: 'quoted' })
    this.persist()
    this.say(`quoted ${this.fmt(usdc)} → ${sats.toLocaleString('en-US')} sats (${q.id})`)
    return q
  }

  /**
   * On a source where the receiver acts first (Lightning), issue what the donor pays: a hold invoice for the quoted
   * amount under the DONOR's hashlock. We can't settle it without the secret, so issuing it costs us nothing.
   */
  async sourceRequest (quoteId: string, hashlock: string, refundAfter: number): Promise<string> {
    const s = this.swaps.get(quoteId)
    if (s === undefined || s.state !== 'quoted') throw new Error('unknown or already used quote')
    if (this.source.request === undefined) throw new Error(`${this.source.name} needs no payment request: lock directly`)
    if ((await this.source.now()) > s.quote.expiresAt) throw new Error('the quote expired')
    if (!/^[0-9a-f]{64}$/.test(hashlock)) throw new Error('hashlock must be 32 bytes hex')
    if (!Number.isSafeInteger(refundAfter) || refundAfter < s.quote.minSourceRefundAfter) throw new Error('the timeout is too short to be safe')
    const request = await this.source.request(this.usdc.address, { amount: s.quote.usdc, hashlock, refundAfter })
    this.say(`${quoteId}: issued a payment request for ${this.fmt(s.quote.usdc)} under the donor's hashlock`)
    return request
  }

  /** The donor says they locked USDC. Verify it on the other chain, then lock sats for them. */
  async acceptSourceLock (quoteId: string, sourceHtlcId: string): Promise<BsvLock> {
    const s = this.swaps.get(quoteId)
    if (s === undefined || s.state !== 'quoted') throw new Error('no open quote')
    const reject = (why: string): never => { s.state = 'rejected'; s.note = why; this.persist(); this.say(`rejected ${quoteId}: ${why}`); throw new Error(why) }
    if ((await this.source.now()) > s.quote.expiresAt) reject('the quote expired')
    // One source lock pays for one BSV lock. Without this, a donor could present the same USDC lock
    // against two quotes, claim both BSV locks with the one secret, and leave us one USDC claim.
    if ([...this.swaps.values()].some(o => o !== s && o.state !== 'rejected' && o.sourceHtlcId === sourceHtlcId)) reject(`that ${this.sym} lock is already used for another swap`)
    s.sourceHtlcId = sourceHtlcId // reserve it now: a concurrent call for the same lock sees it from here on
    this.persist()
    const h = await this.source.htlc(sourceHtlcId)
    if (h === undefined || h.state !== 'locked') reject(`no locked ${this.sym} found on the other chain`)
    if (h!.confirmations !== undefined && h!.confirmations < this.config.minSourceConfirmations) {
      // Not a refusal: the quote stays open, the donor asks again once the lock is deeper.
      s.sourceHtlcId = undefined
      this.persist()
      throw new Error(`wait: the ${this.sym} lock has ${h!.confirmations} of ${this.config.minSourceConfirmations} confirmations; ask again shortly`)
    }
    if (h!.receiver !== this.usdc.address) reject(`the ${this.sym} lock does not pay this agent`)
    if (h!.amount !== s.quote.usdc) reject(`the ${this.sym} lock is ${this.fmt(h!.amount)}, the quote was ${this.fmt(s.quote.usdc)}`)
    if (h!.refundAfter < s.quote.minSourceRefundAfter) reject(`the ${this.sym} lock's timeout is too short to be safe`)
    const refundAfter = h!.refundAfter - this.config.safetyMargin // T2 < T1: the donor can always claim first
    const key = await newSwapKey(this.wallet)
    const pending = { terms: { hashlock: h!.hashlock, receiver: s.quote.donorBsvKey, sender: key.publicKey, refundAfter }, satoshis: this.lockedAmount(s.quote) }
    // Write the intent BEFORE broadcasting: a crash in between leaves 'locking', which step() resolves
    // from the wallet's swap basket, so the sats are never orphaned.
    Object.assign(s, { senderKeyID: key.keyID, pending, state: 'locking' })
    this.persist()
    let lock: BsvLock
    try {
      lock = await lockSats(this.wallet, pending.terms, pending.satoshis, key.keyID)
    } catch (e) {
      const found = await findLock(this.wallet, pending.terms, pending.satoshis).catch(() => undefined)
      if (found === undefined) reject(`could not lock sats: ${(e as Error).message}`)
      lock = found!
    }
    Object.assign(s, { lock, state: 'locked', pending: undefined })
    this.persist() // from here on a restart must not lose this swap: it holds our sats
    this.say(`saw ${this.fmt(h!.amount)} locked for us; locked ${lock.satoshis.toLocaleString('en-US')} sats for the donor (tx ${lock.txid.slice(0, 12)}…)`)
    return lock
  }

  /** How many sats to lock for a quote. An honest agent locks exactly what it quoted (tests and demos override this to play a cheater). */
  protected lockedAmount (quote: Quote): number { return quote.sats }

  /** Watch open swaps: collect USDC once the donor's claim reveals the secret; refund sats after T2. */
  async step (): Promise<void> {
    await this.recover()
    for (const s of this.swaps.values()) {
      if (s.state !== 'locked' || s.lock === undefined) continue
      const spend = await this.findSpend(s.lock.txid, s.lock.vout)
      const input = spend?.inputs.find(i => i.sourceTXID === s.lock!.txid && i.sourceOutputIndex === s.lock!.vout)
      const secret = input?.unlockingScript !== undefined ? secretFromClaim(input.unlockingScript) : undefined
      if (secret !== undefined) {
        await this.usdc.claim(s.sourceHtlcId!, secret)
        s.state = 'settled'
        this.persist()
        this.say(`donor claimed the sats; read the secret from BSV and collected ${this.fmt(s.quote.usdc)}`)
      } else if (spend === undefined && (await this.source.now()) >= s.lock.terms.refundAfter) {
        await refundSats(this.wallet, s.lock, s.senderKeyID!)
        s.state = 'refunded'
        this.persist()
        this.say(`donor never claimed; refunded our ${s.quote.sats.toLocaleString('en-US')} sats`)
        // Where the receiver can give a held lock back at once (Lightning: cancel the hold invoice), do it:
        // the donor gets their money now instead of at the source timeout. Best effort; the timeout still applies.
        if (this.usdc.release !== undefined) {
          await this.usdc.release(s.sourceHtlcId!).then(() => this.say(`${s.quote.id}: released the donor's ${this.sym} lock`), e => this.say(`${s.quote.id}: could not release the donor's lock: ${(e as Error).message}`))
        }
      }
    }
  }

  /** Resolve swaps a crash left in 'locking': the lock is in our basket (now 'locked') or was never made ('rejected'). */
  private async recover (): Promise<void> {
    for (const s of this.swaps.values()) {
      if (s.state !== 'locking' || s.pending === undefined) continue
      const found = await findLock(this.wallet, s.pending.terms, s.pending.satoshis)
      if (found !== undefined) {
        Object.assign(s, { lock: found, state: 'locked', pending: undefined })
        this.say(`recovered our lock for ${s.quote.id} after a restart (tx ${found.txid.slice(0, 12)}…)`)
      } else {
        Object.assign(s, { state: 'rejected', note: 'our BSV lock was never broadcast', pending: undefined })
        this.say(`${s.quote.id}: no lock was made before the restart; the donor refunds their ${this.sym} after the timeout`)
      }
      this.persist()
    }
  }

  async lockFor (quoteId: string): Promise<BsvLock | undefined> { return structuredClone(this.swaps.get(quoteId)?.lock) }

  state (quoteId: string): LpSwap['state'] | undefined { return this.swaps.get(quoteId)?.state }
}
