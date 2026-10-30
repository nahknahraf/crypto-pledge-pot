/**
 * The donor's side of a swap: bring USDC from another chain into the donor's
 * OWN BSV wallet, never handing it to anyone.
 *
 *  1. ask for a quote (the sats will pay a fresh key derived in the donor's wallet);
 *  2. make a secret; lock the USDC on the other chain for the liquidity agent,
 *     refundable to the donor after T1;
 *  3. the agent locks sats on BSV; the donor CHECKS that lock before anything
 *     else: SPV, the same hashlock, pays the donor's key, at least the quoted
 *     sats, and a timeout safely before T1;
 *  4. claim the sats with the secret (this reveals it, so the agent can then
 *     collect the USDC; that's the deal);
 *  5. if the agent never locks or locks wrong terms: refund the USDC after T1.
 */
import { Transaction, Utils, type ChainTracker, type WalletInterface } from '@bsv/sdk'
import { newSecret, parseSwapScript } from '../core/swap'
import { claimSats, newSwapKey, type BsvLock } from './bsv'
import type { LiquidityAgent, Quote } from './liquidityAgent'
import { formatUsdc, type SourceAccount, type SourceChain } from './usdcChain'

export interface DonorSwapOptions {
  /** How long the donor's USDC lock runs (seconds). */
  sourceWindow: number
  /** The agent's BSV timeout must end at least this long before ours (seconds). */
  safetyMargin: number
}
export const DEFAULT_DONOR_SWAP: DonorSwapOptions = { sourceWindow: 5 * 3600, safetyMargin: 3600 }

export interface SwapRecord {
  quote: Quote
  secret: string
  hashlock: string
  receiverKeyID: string
  sourceHtlcId?: string
  lock?: BsvLock
  claimTxid?: string
  state: 'quoted' | 'source-locked' | 'claimed' | 'refunded' | 'refused'
  /** Plain-language trail, for the donor's memo. */
  steps: string[]
}

export class DonorSwap {
  private readonly usdc: SourceAccount

  constructor (
    readonly wallet: WalletInterface,
    readonly source: SourceChain,
    donorAddress: string,
    readonly chainTracker: ChainTracker,
    readonly options: DonorSwapOptions = DEFAULT_DONOR_SWAP
  ) {
    this.usdc = source.account(donorAddress)
  }

  /** Get a quote for `usdc` micro-USDC, paying a fresh key in the donor's wallet. */
  async requestQuote (lp: LiquidityAgent, usdc: number): Promise<SwapRecord> {
    const key = await newSwapKey(this.wallet)
    const quote = await lp.quote(usdc, key.publicKey)
    const { secret, hashlock } = newSecret()
    return { quote, secret, hashlock, receiverKeyID: key.keyID, state: 'quoted', steps: [`quote: ${formatUsdc(usdc)} → ${quote.sats.toLocaleString('en-US')} sats`] }
  }

  /** Lock the USDC (refundable to the donor after T1) and tell the agent; returns the agent's BSV lock. */
  async lockAndRequest (lp: LiquidityAgent, r: SwapRecord): Promise<SwapRecord> {
    const refundAfter = Math.max(this.source.now() + this.options.sourceWindow, r.quote.minSourceRefundAfter)
    r.sourceHtlcId = await this.usdc.lock({ receiver: r.quote.lpAddress, amount: r.quote.usdc, hashlock: r.hashlock, refundAfter })
    r.state = 'source-locked'
    r.steps.push(`locked ${formatUsdc(r.quote.usdc)} on ${this.source.name}, refundable to you after the timeout`)
    try {
      r.lock = await lp.acceptSourceLock(r.quote.id, r.sourceHtlcId)
    } catch (e) {
      r.steps.push(`the liquidity agent did not lock sats: ${(e as Error).message}`)
    }
    return r
  }

  /** Check the agent's BSV lock with our own eyes. Returns the problems (empty = safe to claim). */
  async verifyLock (r: SwapRecord): Promise<string[]> {
    const problems: string[] = []
    if (r.lock === undefined) return ['no BSV lock yet']
    const tx = Transaction.fromAtomicBEEF(Utils.toArray(r.lock.beef, 'hex'))
    if (tx.id('hex') !== r.lock.txid) problems.push('the lock transaction id does not match')
    const out = tx.outputs[r.lock.vout]
    const terms = out !== undefined ? parseSwapScript(out.lockingScript) : undefined
    if (terms === undefined) return [...problems, 'that output is not an AtomicSwap lock']
    const { publicKey: ourKey } = await this.wallet.getPublicKey({ protocolID: [1, 'cryptopledgepot swap'], keyID: r.receiverKeyID, counterparty: 'self' })
    if (terms.hashlock !== r.hashlock) problems.push('the lock uses a different hashlock')
    if (terms.receiver !== ourKey) problems.push('the lock does not pay your key')
    if ((out.satoshis ?? 0) < r.quote.sats) problems.push(`the lock holds ${(out.satoshis ?? 0).toLocaleString('en-US')} sats, less than the quoted ${r.quote.sats.toLocaleString('en-US')}`)
    const h = await this.source.htlc(r.sourceHtlcId!)
    if (h !== undefined && terms.refundAfter > h.refundAfter - this.options.safetyMargin) problems.push('the lock\'s timeout is too close to yours to claim safely')
    if (!(await tx.verify(this.chainTracker).catch(() => false))) problems.push('the lock failed SPV verification')
    return problems
  }

  /** Claim the sats into the donor's wallet, only if the lock checks out. */
  async claim (r: SwapRecord): Promise<SwapRecord> {
    const problems = await this.verifyLock(r)
    if (problems.length > 0) {
      r.state = 'refused'
      r.steps.push(`not claiming: ${problems.join('; ')}. Your USDC comes back after the timeout.`)
      return r
    }
    const c = await claimSats(this.wallet, r.lock!, r.receiverKeyID, r.secret)
    r.claimTxid = c.txid
    r.state = 'claimed'
    r.steps.push(`claimed ${r.lock!.satoshis.toLocaleString('en-US')} sats into your own BSV wallet (tx ${c.txid.slice(0, 12)}…)`)
    return r
  }

  /** Take the USDC back after T1 (the agent never locked, locked wrong terms, or we never claimed). */
  async refundSource (r: SwapRecord): Promise<SwapRecord> {
    await this.usdc.refund(r.sourceHtlcId!)
    r.state = 'refunded'
    r.steps.push(`refunded ${formatUsdc(r.quote.usdc)} to you on ${this.source.name}`)
    return r
  }
}
