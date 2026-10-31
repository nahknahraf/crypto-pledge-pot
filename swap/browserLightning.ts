/**
 * The donor side of a Lightning swap as one function, for a web page: pay the liquidity agent's hold
 * invoice from ANY Lightning wallet, then claim the sats into the donor's own BSV wallet.
 * Plain code with no React, tested end to end against real LND nodes (test/bridge.lightning.test.ts).
 *
 * The donor needs no Lightning node: the invoice is checked locally (swap/bolt11.ts) before paying,
 * and the BSV lock is checked on chain before claiming. If anything is off, the donor doesn't claim,
 * and the held payment fails back when the agent cancels or the HTLC times out.
 */
import type { ChainTracker, WalletInterface } from '@bsv/sdk'
import { DonorSwap, type SwapRecord } from './donorSwap'
import { LightningChain } from './lightningChain'
import { LiquidityClient } from './lpClient'

/** A WebLN provider (e.g. Alby): https://www.webln.guide */
export interface WebLn { enable: () => Promise<void>, sendPayment: (invoice: string) => Promise<unknown> }

/**
 * Pay with WebLN without waiting: sendPayment only resolves when the agent settles, which happens after
 * the donor's BSV claim. A failure is reported through onError (the swap then simply doesn't proceed).
 */
export const weblnPayer = (webln: WebLn, onError: (e: Error) => void = () => {}) => async (invoice: string): Promise<void> => {
  await webln.enable()
  void webln.sendPayment(invoice).catch(e => onError(e as Error))
}

export interface LightningSwapConfig {
  lpUrl: string
  retryMs?: number
  maxRetries?: number
  /** The clock (unix seconds) timeouts are computed with; default the wall clock. Must match the agent's. */
  clock?: () => number
}

export async function swapLightningToSats (bsvWallet: WalletInterface, chainTracker: ChainTracker, cfg: LightningSwapConfig, sats: number, payer: (invoice: string) => Promise<void>, onStep: (line: string) => void = () => {}): Promise<SwapRecord> {
  const ln = new LightningChain({ nodes: [], payer, clock: cfg.clock })
  const swap = new DonorSwap(bsvWallet, ln, 'your Lightning wallet', chainTracker)
  const lp = new LiquidityClient(cfg.lpUrl)
  let r = await swap.requestQuote(lp, sats)
  onStep(r.steps.at(-1)!)
  r = await swap.lockAndRequest(lp, r) // fetches the invoice, checks it, starts the payment
  onStep('invoice checked (your hash, the agreed amount, the agent\'s node, a long enough timeout); payment sent from your wallet')
  for (let i = 0; r.lock === undefined && i < (cfg.maxRetries ?? 40); i++) {
    if (!/wait:/.test(r.steps.at(-1) ?? '')) break // a refusal, not a wait
    onStep('waiting for your payment to reach the liquidity agent…')
    await new Promise(resolve => setTimeout(resolve, cfg.retryMs ?? 3_000))
    r.steps.pop()
    r = await swap.requestLock(lp, r)
  }
  if (r.lock === undefined) { onStep(`${r.steps.at(-1) ?? 'no lock'}. Your payment fails back to your wallet.`); return r }
  onStep(`the liquidity agent locked ${r.lock.satoshis.toLocaleString('en-US')} sats for you; checking it…`)
  r = await swap.claim(r)
  onStep(r.steps.at(-1)!)
  return r
}
