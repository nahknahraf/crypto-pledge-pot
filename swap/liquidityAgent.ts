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
import { secretFromClaim } from '../core/swap'
import { lockSats, newSwapKey, refundSats, type BsvLock, type SpendFinder } from './bsv'
import { readPrice, type SignedResponse } from './api3Price'
import { formatUsdc, USDC, type SourceAccount, type SourceChain } from './usdcChain'

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
  /**
   * Price from API3 instead of the fixed satsPerUsdc: a signed BSV/USD response (AirnodeHub). The quote is
   * derived from it and carries it, so the donor can hand it to a PriceGuardedHTLC, which re-checks the rate.
   */
  priceSource?: () => Promise<SignedResponse>
  /** With a priceSource: the agent's margin below the market rate, in basis points (default 50 = 0.5%). */
  spreadBps?: number
}

export const DEFAULT_LIQUIDITY: LiquidityConfig = { satsPerUsdc: 21_500, maxUsdc: 500 * USDC, feeReserve: 5_000, quoteValidity: 120, minSourceWindow: 4 * 3600, safetyMargin: 2 * 3600 }

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
  /** The signed API3 BSV/USD response the quote is based on (with a priceSource). */
  priceProof?: SignedResponse
}

interface Swap { quote: Quote, sourceHtlcId?: string, lock?: BsvLock, senderKeyID?: string, state: 'quoted' | 'locked' | 'settled' | 'refunded' | 'rejected', note?: string }

export class LiquidityAgent {
  private readonly swaps = new Map<string, Swap>()
  private readonly usdc: SourceAccount
  readonly log: string[] = []

  constructor (
    readonly wallet: WalletInterface,
    readonly source: SourceChain,
    lpAddress: string,
    readonly findSpend: SpendFinder,
    readonly spendable: () => Promise<number>,
    readonly config: LiquidityConfig = DEFAULT_LIQUIDITY
  ) {
    this.usdc = source.account(lpAddress)
  }

  private say (line: string): void { this.log.push(line) }

  async quote (usdc: number, donorBsvKey: string): Promise<Quote> {
    if (!Number.isSafeInteger(usdc) || usdc <= 0) throw new Error('amount must be positive')
    if (usdc > this.config.maxUsdc) throw new Error(`above this agent's limit of ${formatUsdc(this.config.maxUsdc)}`)
    if (!/^0[23][0-9a-f]{64}$/.test(donorBsvKey)) throw new Error('donor key must be a compressed public key')
    let satsPerUsdc = this.config.satsPerUsdc
    let priceProof: SignedResponse | undefined
    if (this.config.priceSource !== undefined) {
      priceProof = await this.config.priceSource()
      // 1 USDC = 1 USD; sats per USD = 1e8 / (USD per BSV); keep the agent's spread.
      satsPerUsdc = (1e8 / readPrice(priceProof).usd) * (1 - (this.config.spreadBps ?? 50) / 10_000)
    }
    const sats = Math.floor((usdc / USDC) * satsPerUsdc)
    const openExposure = [...this.swaps.values()].filter(s => s.state === 'quoted' || s.state === 'locked').reduce((t, s) => t + s.quote.sats, 0)
    if ((await this.spendable()) - openExposure - sats < this.config.feeReserve) throw new Error('not enough BSV inventory for this swap right now')
    const now = await this.source.now()
    const q: Quote = { id: `q${this.swaps.size + 1}`, usdc, sats, lpAddress: this.usdc.address, donorBsvKey, expiresAt: now + this.config.quoteValidity, minSourceRefundAfter: now + this.config.minSourceWindow, ...(priceProof !== undefined ? { priceProof } : {}) }
    this.swaps.set(q.id, { quote: q, state: 'quoted' })
    this.say(`quoted ${formatUsdc(usdc)} → ${sats.toLocaleString('en-US')} sats (${q.id})`)
    return q
  }

  /** The donor says they locked USDC. Verify it on the other chain, then lock sats for them. */
  async acceptSourceLock (quoteId: string, sourceHtlcId: string): Promise<BsvLock> {
    const s = this.swaps.get(quoteId)
    if (s === undefined || s.state !== 'quoted') throw new Error('no open quote')
    const reject = (why: string): never => { s.state = 'rejected'; s.note = why; this.say(`rejected ${quoteId}: ${why}`); throw new Error(why) }
    if ((await this.source.now()) > s.quote.expiresAt) reject('the quote expired')
    const h = await this.source.htlc(sourceHtlcId)
    if (h === undefined || h.state !== 'locked') reject('no locked USDC found on the other chain')
    if (h!.receiver !== this.usdc.address) reject('the USDC lock does not pay this agent')
    if (h!.amount !== s.quote.usdc) reject(`the USDC lock is ${formatUsdc(h!.amount)}, the quote was ${formatUsdc(s.quote.usdc)}`)
    if (h!.refundAfter < s.quote.minSourceRefundAfter) reject('the USDC lock\'s timeout is too short to be safe')
    const refundAfter = h!.refundAfter - this.config.safetyMargin // T2 < T1: the donor can always claim first
    const key = await newSwapKey(this.wallet)
    const lock = await lockSats(this.wallet, { hashlock: h!.hashlock, receiver: s.quote.donorBsvKey, sender: key.publicKey, refundAfter }, this.lockedAmount(s.quote), key.keyID)
    Object.assign(s, { sourceHtlcId, lock, senderKeyID: key.keyID, state: 'locked' })
    this.say(`saw ${formatUsdc(h!.amount)} locked for us; locked ${lock.satoshis.toLocaleString('en-US')} sats for the donor (tx ${lock.txid.slice(0, 12)}…)`)
    return lock
  }

  /** How many sats to lock for a quote. An honest agent locks exactly what it quoted (tests and demos override this to play a cheater). */
  protected lockedAmount (quote: Quote): number { return quote.sats }

  /** Watch open swaps: collect USDC once the donor's claim reveals the secret; refund sats after T2. */
  async step (): Promise<void> {
    for (const s of this.swaps.values()) {
      if (s.state !== 'locked' || s.lock === undefined) continue
      const spend = await this.findSpend(s.lock.txid, s.lock.vout)
      const input = spend?.inputs.find(i => i.sourceTXID === s.lock!.txid && i.sourceOutputIndex === s.lock!.vout)
      const secret = input?.unlockingScript !== undefined ? secretFromClaim(input.unlockingScript) : undefined
      if (secret !== undefined) {
        await this.usdc.claim(s.sourceHtlcId!, secret)
        s.state = 'settled'
        this.say(`donor claimed the sats; read the secret from BSV and collected ${formatUsdc(s.quote.usdc)}`)
      } else if (spend === undefined && (await this.source.now()) >= s.lock.terms.refundAfter) {
        await refundSats(this.wallet, s.lock, s.senderKeyID!)
        s.state = 'refunded'
        this.say(`donor never claimed; refunded our ${s.quote.sats.toLocaleString('en-US')} sats`)
      }
    }
  }

  state (quoteId: string): Swap['state'] | undefined { return this.swaps.get(quoteId)?.state }
}
