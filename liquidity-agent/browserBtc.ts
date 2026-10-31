/**
 * The donor side of an on-chain BTC swap as one function, for a web page: pay the HTLC address from
 * ANY Bitcoin wallet, then claim the sats into the donor's own BSV wallet.
 *
 * No browser-wallet signing is needed: the page makes a throwaway REFUND KEY, which is the HTLC's
 * "sender". The donor saves it (with the HTLC id), together with a refund address of their own wallet.
 * It is only ever needed if the swap fails: after the timeout, refundBtc() sends the BTC to that address.
 * The happy path never uses it. Browser-safe (Esplora over fetch); tested on regtest (bridge.btc).
 */
import { PrivateKey, type ChainTracker, type WalletInterface } from '@bsv/sdk'
import { btcPublicKey, decodeSegwitAddress, type BtcNetwork } from './btc'
import { BtcChain, EsploraBackend, type BtcBackend } from './btcChain'
import { DonorSwap, type SwapRecord } from './donorSwap'
import { LiquidityClient } from './lpClient'

export interface BtcSwapConfig {
  lpUrl: string
  network: BtcNetwork
  /** Bitcoin data: an Esplora API URL (e.g. https://mempool.space/signet/api), or a backend (tests). */
  esploraUrl?: string
  backend?: BtcBackend
  /** A segwit address of the donor's own wallet: where a refund would go. */
  refundTo: string
  retryMs?: number
  maxRetries?: number
  fundingPollMs?: number
}

/** What the donor must keep until the swap is done: enough to refund after the timeout. */
export interface BtcRefundTicket { refundKey: string, htlcId?: string, refundTo: string, network: BtcNetwork, refundAfter?: number }

const backendOf = (cfg: Pick<BtcSwapConfig, 'esploraUrl' | 'backend'>): BtcBackend => cfg.backend ?? new EsploraBackend(cfg.esploraUrl ?? 'https://mempool.space/api')

/**
 * `pay(address, sats)`: show the address (and amount) to the donor, or hand it to a wallet; return when
 * the payment is sent. `onTicket` receives the refund ticket as soon as it exists: SAVE IT.
 */
export async function swapBtcToSats (bsvWallet: WalletInterface, chainTracker: ChainTracker, cfg: BtcSwapConfig, sats: number, pay: (address: string, sats: number) => Promise<void>, onTicket: (t: BtcRefundTicket) => void, onStep: (line: string) => void = () => {}): Promise<{ record: SwapRecord, ticket: BtcRefundTicket }> {
  decodeSegwitAddress(cfg.refundTo, cfg.network) // a typo here would make a refund impossible: check first
  const refundKey = PrivateKey.fromRandom()
  const ticket: BtcRefundTicket = { refundKey: refundKey.toHex(), refundTo: cfg.refundTo, network: cfg.network }
  onTicket(ticket)
  const btc = new BtcChain({ backend: backendOf(cfg), network: cfg.network, signers: [refundKey], refundTo: cfg.refundTo, fundingPollMs: cfg.fundingPollMs, funder: async (address, amount) => { await pay(address, amount); return undefined } })
  const swap = new DonorSwap(bsvWallet, btc, btcPublicKey(refundKey), chainTracker)
  const lp = new LiquidityClient(cfg.lpUrl)
  let r = await swap.requestQuote(lp, sats)
  onStep(r.steps.at(-1)!)
  r = await swap.lockAndRequest(lp, r) // shows the HTLC address via pay(), then waits for the payment on chain
  Object.assign(ticket, { htlcId: r.sourceHtlcId, refundAfter: (await btc.htlc(r.sourceHtlcId!))?.refundAfter }); onTicket(ticket)
  onStep('your BTC is in the HTLC; it can only go to the agent with your secret, or back to you after the timeout')
  for (let i = 0; r.lock === undefined && i < (cfg.maxRetries ?? 120); i++) {
    if (!/wait:/.test(r.steps.at(-1) ?? '')) break // a refusal, not a wait
    onStep('waiting for a confirmation of your BTC payment…')
    await new Promise(resolve => setTimeout(resolve, cfg.retryMs ?? 30_000))
    r.steps.pop()
    r = await swap.requestLock(lp, r)
  }
  if (r.lock === undefined) { onStep(`${r.steps.at(-1) ?? 'no lock'}. Keep your refund ticket: after the timeout, refund your BTC with it.`); return { record: r, ticket } }
  onStep(`the liquidity agent locked ${r.lock.satoshis.toLocaleString('en-US')} sats for you; checking it…`)
  r = await swap.claim(r)
  onStep(r.steps.at(-1)!)
  return { record: r, ticket }
}

/** After the timeout: send the BTC back to the ticket's refund address. */
export async function refundBtc (ticket: BtcRefundTicket, cfg: Pick<BtcSwapConfig, 'esploraUrl' | 'backend'>): Promise<void> {
  if (ticket.htlcId === undefined) throw new Error('this ticket has no HTLC: nothing was locked')
  const key = PrivateKey.fromHex(ticket.refundKey)
  const btc = new BtcChain({ backend: backendOf(cfg), network: ticket.network, signers: [key], refundTo: ticket.refundTo })
  await btc.account(btcPublicKey(key)).refund(ticket.htlcId)
}
