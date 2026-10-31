/**
 * A capped BRC-121 (HTTP 402) payer for the agent.
 *
 * create402Fetch would pay whatever the server asks. An autonomous agent must
 * not, so this does it in two steps:
 *   1. plain request → read the 402 challenge (x-bsv-sats, x-bsv-server)
 *   2. refuse unless the host is allow-listed and the price is within the cap,
 *      then build the payment with constructPaymentHeaders and retry.
 * The limits live in code; nothing an API or an LLM says can raise them.
 */
import { constructPaymentHeaders } from '@bsv/402-pay/client'
import { Beef, Transaction, Utils, type WalletInterface } from '@bsv/sdk'
import { withHostOriginator } from '../examples/payPerRequest'

export interface PaidResponse<T = unknown> {
  body: T
  /** Satoshis paid (0 if the resource was free). */
  paid: number
  /** Payment transaction id (undefined if free). */
  txid?: string
}

export class PaymentRefused extends Error {}

export interface Pay402Options {
  wallet: WalletInterface
  /** Hosts (host:port) the agent may pay. */
  allowedHosts: string[]
  /** Highest price per call the agent accepts. */
  maxPricePerCall: number
  fetchImpl?: typeof fetch
}

/** Txid of the payment carried in the x-bsv-beef header (base64 BEEF / AtomicBEEF). */
function paymentTxid (beefBase64: string): string | undefined {
  try {
    const bytes = Utils.toArray(beefBase64, 'base64')
    try { return Transaction.fromAtomicBEEF(bytes).id('hex') } catch { /* plain BEEF */ }
    const beef = Beef.fromBinary(bytes)
    return beef.txs[beef.txs.length - 1]?.txid
  } catch { return undefined }
}

/**
 * The payment went out but the provider did not deliver (an HTTP error or a body that is
 * not JSON). The sats are spent: callers must record them, not retry blindly.
 */
export class PaidButNotServed extends Error {
  constructor (message: string, readonly paid: number, readonly txid?: string) { super(message); this.name = 'PaidButNotServed' }
}

export function createCappedPayer (opts: Pay402Options) {
  const doFetch = opts.fetchImpl ?? fetch
  const wallet = withHostOriginator(opts.wallet)

  return async function payAndGet<T = unknown> (url: string): Promise<PaidResponse<T>> {
    const host = new URL(url).host
    if (!opts.allowedHosts.includes(host)) throw new PaymentRefused(`host ${host} is not on the agent's allow-list`)

    const first = await doFetch(url)
    if (first.ok) return { body: await first.json() as T, paid: 0 }
    if (first.status !== 402) throw new Error(`${url}: HTTP ${first.status}`)

    const price = Number(first.headers.get('x-bsv-sats'))
    const server = first.headers.get('x-bsv-server') ?? ''
    if (!Number.isSafeInteger(price) || price <= 0) throw new PaymentRefused(`${url}: malformed price "${first.headers.get('x-bsv-sats')}"`)
    if (price > opts.maxPricePerCall) throw new PaymentRefused(`${url} asks ${price} sats; the agent's cap is ${opts.maxPricePerCall}`)
    if (!/^0[23][0-9a-f]{64}$/.test(server)) throw new PaymentRefused(`${url}: malformed server key`)

    const headers = await constructPaymentHeaders(wallet, url, price, server)
    const paid = await doFetch(url, { headers: headers as unknown as Record<string, string> })
    const txid = paymentTxid(headers['x-bsv-beef'])
    if (!paid.ok) throw new PaidButNotServed(`${url}: paid ${price} sats but got HTTP ${paid.status}`, price, txid)
    let body: T
    try { body = await paid.json() as T } catch { throw new PaidButNotServed(`${url}: paid ${price} sats but the answer is not JSON`, price, txid) }
    return { body, paid: price, txid }
  }
}
