/**
 * The whole donor-side swap as one function, for the web app's "Bring USDC" page:
 * the donor's EVM wallet (EIP-1193) locks USDC, a liquidity agent (over HTTP)
 * locks sats, the donor's BSV wallet checks that lock and claims the sats.
 * Plain code with no React, so it is tested end to end (test/bridge.browser.test.ts).
 */
import type { ChainTracker, WalletInterface } from '@bsv/sdk'
import { connectBrowserEvm, type Eip1193 } from './browserEvm'
import { DonorSwap, type SwapRecord } from './donorSwap'
import type { EvmChainOptions } from './evmChain'
import { LiquidityClient } from './lpClient'

export interface BrowserSwapConfig {
  /** The liquidity agent's base URL (npm run lp). */
  lpUrl: string
  evm: Omit<EvmChainOptions, 'signers' | 'signerTransport'>
  /** How often and how long to ask again while the agent waits for confirmations. */
  retryMs?: number
  maxRetries?: number
}

export async function swapUsdcToSats (provider: Eip1193, bsvWallet: WalletInterface, chainTracker: ChainTracker, cfg: BrowserSwapConfig, usdc: number, onStep: (line: string) => void = () => {}): Promise<SwapRecord> {
  const { chain, address } = await connectBrowserEvm(provider, cfg.evm)
  onStep(`EVM wallet connected: ${address}`)
  const swap = new DonorSwap(bsvWallet, chain, address, chainTracker)
  const lp = new LiquidityClient(cfg.lpUrl)
  let r = await swap.requestQuote(lp, usdc)
  onStep(r.steps.at(-1)!)
  r = await swap.lockAndRequest(lp, r)
  onStep(r.steps.find(s => s.startsWith('locked')) ?? 'USDC locked')
  for (let i = 0; r.lock === undefined && i < (cfg.maxRetries ?? 20); i++) {
    if (!/wait:/.test(r.steps.at(-1) ?? '')) break // a refusal, not a wait
    onStep('waiting for confirmations of your USDC lock…')
    await new Promise(resolve => setTimeout(resolve, cfg.retryMs ?? 15_000))
    r.steps.pop()
    r = await swap.requestLock(lp, r)
  }
  if (r.lock === undefined) { onStep(`${r.steps.at(-1) ?? 'no lock'}. Your USDC comes back to you after the timeout.`); return r }
  onStep(`the liquidity agent locked ${r.lock.satoshis.toLocaleString('en-US')} sats for you; checking it…`)
  r = await swap.claim(r)
  onStep(r.steps.at(-1)!)
  return r
}
