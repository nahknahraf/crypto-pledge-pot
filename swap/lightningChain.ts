/**
 * Lightning as a swap source: the donor pays a HOLD INVOICE whose payment hash is the swap's hashlock.
 *
 *  1. The liquidity agent issues the hold invoice (SourceChain.request) under the donor's hashlock.
 *     It can't settle it: only the donor knows the secret.
 *  2. The donor checks the invoice (hash, amount, payee, timeout) and pays it. The payment is HELD:
 *     the agent's node has the HTLC, but nothing has settled. This is the "lock".
 *  3. The agent sees the held payment and locks BSV sats for the donor (T2 before the HTLC expires).
 *  4. The donor claims the sats on BSV, which reveals the secret; the agent settles the invoice with it ("claim").
 *  If the donor never claims, the agent cancels the invoice and the payment fails back to the donor;
 *  if the agent disappears, the HTLC expires and the donor's node gets the money back on chain.
 *
 * Ids are the payment hash (hex). Addresses are node public keys. Amounts are sats (BTC, 8 decimals).
 * The HTLC's timeout is in blocks; refundAfter is estimated at `blockSeconds` per block from now.
 * This process sees an HTLC through whichever of its nodes knows it: the payee's invoice, or the payer's payment.
 */
import { b64, unb64, type LndRest } from './lnd'
import type { SourceAccount, SourceAsset, SourceChain, SourceHtlc } from './usdcChain'

export interface LightningChainOptions {
  /** The LND nodes this process controls (the agent's, or the donor's). */
  nodes: LndRest[]
  /** Seconds per block for timeout estimates. Default 600. */
  blockSeconds?: number
  /** The clock (unix seconds); default the wall clock. Tests move it to play out timeouts. */
  clock?: () => number
  /** Most the payer pays in routing fees (sats). Default 100. */
  feeLimitSat?: number
  name?: string
}

export class LightningChain implements SourceChain {
  readonly name: string
  readonly asset: SourceAsset = { symbol: 'BTC', decimals: 8 }
  private readonly pubkeys = new Map<LndRest, string>()
  private readonly blockSeconds: number

  constructor (private readonly o: LightningChainOptions) {
    this.name = o.name ?? 'Bitcoin Lightning'
    this.blockSeconds = o.blockSeconds ?? 600
  }

  /** Lightning has no chain clock of its own; timeouts are block heights, estimated against wall time. */
  async now (): Promise<number> { return this.o.clock?.() ?? Math.floor(Date.now() / 1000) }

  private async pubkeyOf (n: LndRest): Promise<string> {
    if (!this.pubkeys.has(n)) this.pubkeys.set(n, (await n.call('GET', '/v1/getinfo')).identity_pubkey)
    return this.pubkeys.get(n)!
  }

  private async nodeOf (pubkey: string): Promise<LndRest> {
    for (const n of this.o.nodes) if (await this.pubkeyOf(n) === pubkey) return n
    throw new Error(`${this.name}: no node ${pubkey.slice(0, 12)}… in this process`)
  }

  private async timeOfHeight (n: LndRest, height: number): Promise<number> {
    const { block_height: tip } = await n.call<{ block_height: number }>('GET', '/v1/getinfo')
    return (await this.now()) + (height - tip) * this.blockSeconds
  }

  /** The payee issues a hold invoice for the donor's hashlock, with a final CLTV that outlasts refundAfter. */
  async request (receiver: string, a: { amount: number, hashlock: string, refundAfter: number }): Promise<string> {
    const n = await this.nodeOf(receiver)
    const cltv = Math.ceil((a.refundAfter - (await this.now())) / this.blockSeconds) + 1
    const r = await n.call<{ payment_request: string }>('POST', '/v2/invoices/hodl', { hash: b64(a.hashlock), value: String(a.amount), cltv_expiry: String(cltv), expiry: '3600', memo: 'CryptoPledgePot swap' })
    return r.payment_request
  }

  async htlc (id: string): Promise<SourceHtlc | undefined> {
    if (!/^[0-9a-f]{64}$/.test(id)) return undefined
    for (const n of this.o.nodes) {
      const me = await this.pubkeyOf(n)
      // Payee view: our invoice.
      const inv = await n.call<any>('GET', `/v1/invoice/${id}`).catch(() => undefined)
      if (inv !== undefined && inv.r_hash !== undefined) {
        const held = (inv.htlcs ?? []).filter((h: any) => h.state === 'ACCEPTED' || h.state === 'SETTLED')
        const expiry = held.length > 0 ? Math.min(...held.map((h: any) => Number(h.expiry_height))) : 0
        const base = { id, sender: 'lightning payer', receiver: me, amount: Number(inv.amt_paid_sat ?? 0), hashlock: id, refundAfter: held.length > 0 ? await this.timeOfHeight(n, expiry) : 0 }
        if (inv.state === 'OPEN') return { ...base, state: 'locked', confirmations: 0 } // not paid yet: an agent answers "wait:"
        if (inv.state === 'ACCEPTED') return { ...base, state: 'locked' }
        if (inv.state === 'SETTLED') return { ...base, state: 'claimed', secret: unb64(inv.r_preimage) }
        return { ...base, state: 'refunded' } // CANCELED
      }
      // Payer view: our payment.
      const pays = await n.call<any>('GET', '/v1/payments?include_incomplete=true&reversed=true&max_payments=200')
      const p = (pays.payments ?? []).find((x: any) => x.payment_hash === id)
      if (p !== undefined) {
        const route = p.htlcs?.[p.htlcs.length - 1]?.route
        const base = { id, sender: me, receiver: route?.hops?.at(-1)?.pub_key ?? '', amount: Number(p.value_sat), hashlock: id, refundAfter: route !== undefined ? await this.timeOfHeight(n, Number(route.total_time_lock)) : 0 }
        if (p.status === 'SUCCEEDED') return { ...base, state: 'claimed', secret: p.payment_preimage }
        if (p.status === 'FAILED') return { ...base, state: 'refunded' }
        return { ...base, state: 'locked' }
      }
    }
    return undefined
  }

  account (address: string): SourceAccount {
    return {
      address,
      /** Spendable balance in this node's channels. */
      balance: async () => Number((await (await this.nodeOf(address)).call('GET', '/v1/balance/channels')).local_balance?.sat ?? 0),
      /** Pay the hold invoice, after checking it is exactly what we agreed. Resolves once the payment is held. */
      lock: async ({ receiver, amount, hashlock, refundAfter, request }) => {
        if (request === undefined) throw new Error(`${this.name}: no invoice to pay (the liquidity agent issues one first)`)
        const n = await this.nodeOf(address)
        const d = await n.call<any>('GET', `/v1/payreq/${request}`)
        const problems = [
          d.payment_hash !== hashlock && 'the invoice is for a different hash',
          Number(d.num_satoshis) !== amount && `the invoice asks ${d.num_satoshis} sats, not ${amount}`,
          d.destination !== receiver && 'the invoice pays a different node',
          (await this.now()) + (Number(d.cltv_expiry) - 1) * this.blockSeconds < refundAfter - this.blockSeconds && 'the invoice\'s timeout is shorter than agreed'
        ].filter(Boolean)
        if (problems.length > 0) throw new Error(`${this.name}: not paying: ${problems.join('; ')}`)
        await new Promise<void>((resolve, reject) => {
          const stop = n.stream('/v2/router/send', { payment_request: request, timeout_seconds: 60, fee_limit_sat: String(this.o.feeLimitSat ?? 100) }, m => {
            if (m.status === 'IN_FLIGHT' && (m.htlcs ?? []).some((h: any) => h.status === 'IN_FLIGHT')) resolve() // held by the payee; the stream stays open
            if (m.status === 'FAILED') { stop(); reject(new Error(`${this.name}: payment failed: ${m.failure_reason}`)) }
          }, reject)
        })
        return hashlock
      },
      /** The payee settles the held payment with the secret. */
      claim: async (id, secret) => {
        await (await this.nodeOf(address)).call('POST', '/v2/invoices/settle', { preimage: b64(secret) })
      },
      /**
       * The payer can't take a held payment back by itself: it fails back when the payee cancels (`cancel`)
       * or, if the payee vanishes, when the HTLC expires (the payer's node then closes the channel on chain).
       */
      refund: async (id) => {
        const h = await this.htlc(id)
        if (h?.state === 'refunded') return
        throw new Error(`${this.name}: the payment is ${h?.state ?? 'unknown'}: it comes back when the agent cancels the invoice or the HTLC expires (early)`)
      },
      /** The payee cancels the hold invoice: the payment fails back to the payer at once. */
      release: async (id) => { await this.cancel(address, id) }
    }
  }

  /** The payee gives up: the held payment fails back to the payer at once. */
  async cancel (receiver: string, id: string): Promise<void> {
    await (await this.nodeOf(receiver)).call('POST', '/v2/invoices/cancel', { payment_hash: b64(id) })
  }
}
