/**
 * A donor's handle on a liquidity agent that runs elsewhere (lpHttp.ts).
 * It implements the same LiquidityProvider interface as the in-process agent,
 * so DonorSwap works with either. Answers are not trusted: DonorSwap checks
 * the quote it gets against the lock it later finds on chain.
 */
import type { BsvLock } from './bsv'
import type { LiquidityProvider, Quote } from './liquidityAgent'

export class LiquidityClient implements LiquidityProvider {
  constructor (readonly baseUrl: string, private readonly fetchImpl: typeof fetch = fetch) {}

  private async post<T> (path: string, body: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const json = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
    if (!res.ok) throw new Error(`liquidity agent: ${(json as { error?: string }).error ?? `HTTP ${res.status}`}`)
    return json as T
  }

  async info (): Promise<Record<string, unknown>> { return await (await this.fetchImpl(`${this.baseUrl}/api/lp`)).json() as Record<string, unknown> }

  async quote (usdc: number, donorBsvKey: string): Promise<Quote> {
    const q = await this.post<Quote>('/api/lp/quote', { usdc, donorBsvKey })
    if (q.usdc !== usdc || q.donorBsvKey !== donorBsvKey) throw new Error('liquidity agent: the quote does not match the request')
    return q
  }

  async lockFor (quoteId: string): Promise<BsvLock | undefined> {
    const res = await this.fetchImpl(`${this.baseUrl}/api/lp/swaps/${encodeURIComponent(quoteId)}`)
    if (!res.ok) return undefined
    return ((await res.json()) as { lock: BsvLock | null }).lock ?? undefined
  }

  async sourceRequest (quoteId: string, hashlock: string, refundAfter: number): Promise<string> {
    return (await this.post<{ request: string }>('/api/lp/request', { quoteId, hashlock, refundAfter })).request
  }

  /** Send a BRC-29 payment (client/payments.ts createBrc29Payment) to top up the agent's sats inventory. */
  async fund (payment: unknown): Promise<{ ok: boolean, txid: string, spendable: number }> {
    return await this.post('/api/lp/fund', payment)
  }

  async acceptSourceLock (quoteId: string, sourceHtlcId: string): Promise<BsvLock> {
    return await this.post<BsvLock>('/api/lp/lock', { quoteId, sourceHtlcId })
  }
}
