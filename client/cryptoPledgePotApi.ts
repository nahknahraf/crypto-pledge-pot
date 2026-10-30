/**
 * HTTP client for the CryptoPledgePot indexer. Reads are plain fetch; writes go
 * through `AuthFetch` (BRC-103/104), so the server knows the caller's verified
 * identity key without accounts or passwords.
 */
import { AuthFetch, type WalletInterface } from '@bsv/sdk'
import type { CampaignMeta } from '../core/campaign'
import type { SpendClaim, SpendingResult } from '../core/paymentPlan'
import type { CampaignDetail, CampaignView, PledgeView, ReleasablePledges, SpendablePledge, SpendView } from '../core/api'

export class CryptoPledgePotApi {
  private auth?: AuthFetch

  constructor (readonly baseUrl: string, wallet?: WalletInterface) {
    if (wallet !== undefined) this.auth = new AuthFetch(wallet)
  }

  /** Attach a wallet for authenticated calls (after the user connects). */
  connect (wallet: WalletInterface): void { this.auth = new AuthFetch(wallet) }

  private async get<T> (path: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`)
    return await this.unwrap<T>(res)
  }

  private async post<T> (path: string, body: unknown, authenticated = true): Promise<T> {
    const init = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    if (!authenticated) return await this.unwrap<T>(await fetch(`${this.baseUrl}${path}`, init))
    if (this.auth === undefined) throw new Error('connect a wallet first')
    return await this.unwrap<T>(await this.auth.fetch(`${this.baseUrl}${path}`, init) as unknown as Response)
  }

  private async unwrap<T> (res: Response): Promise<T> {
    const text = await res.text()
    let body: any
    try { body = text === '' ? undefined : JSON.parse(text) } catch { body = text }
    if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`)
    return body as T
  }

  health = async (): Promise<{ ok: boolean, network: 'main' | 'test' | 'mock', identityKey: string, now: number }> => await this.get('/api/health')
  arbiterKey = async (nonce: string, tag?: string): Promise<string> => (await this.get<{ arbiterKey: string }>(`/api/arbiter-key?nonce=${nonce}${tag !== undefined ? `&tag=${tag}` : ''}`)).arbiterKey
  txBeef = async (txid: string): Promise<string> => (await this.get<{ beef: string }>(`/api/txs/${txid}`)).beef
  campaigns = async (): Promise<CampaignView[]> => await this.get('/api/campaigns')
  campaign = async (id: string): Promise<CampaignDetail> => await this.get(`/api/campaigns/${id}`)
  pledge = async (id: string): Promise<SpendablePledge> => await this.get(`/api/pledges/${encodeURIComponent(id)}`)
  donorPledges = async (identityKey: string): Promise<Array<PledgeView & { campaignTitle: string }>> => await this.get(`/api/donors/${identityKey}/pledges`)
  spends = async (campaignId: string): Promise<SpendView[]> => await this.get(`/api/campaigns/${campaignId}/spends`)
  releasable = async (campaignId: string): Promise<ReleasablePledges> => await this.get(`/api/campaigns/${campaignId}/releasable`)

  /** Report a release or refund transaction (AtomicBEEF hex) so the index follows the escrow. */
  reportSpend = async (beef: string): Promise<{ txid: string, pledges: string[] }> => await this.post('/api/spends', { beef }, false)

  registerCampaign = async (meta: CampaignMeta, anchorBeef: string): Promise<{ id: string, anchorTxid: string }> =>
    await this.post('/api/campaigns', { meta, anchorBeef })

  registerPledge = async (beef: string, outputIndex: number, keyID: string): Promise<PledgeView> =>
    await this.post('/api/pledges', { beef, outputIndex, keyID })

  postUpdate = async (campaignId: string, milestone: number, note: string): Promise<void> => {
    await this.post(`/api/campaigns/${campaignId}/milestones/${milestone}/update`, { note })
  }

  reportSpending = async (campaignId: string, milestone: number, claims: Array<SpendClaim & { beef?: string }>): Promise<SpendingResult> =>
    await this.post(`/api/campaigns/${campaignId}/milestones/${milestone}/spending`, { claims })

  vote = async (campaignId: string, milestone: number, approve: boolean): Promise<void> => {
    await this.post(`/api/campaigns/${campaignId}/milestones/${milestone}/vote`, { approve })
  }

  releaseSignatures = async (campaignId: string, beef: string): Promise<Record<number, string>> =>
    (await this.post<{ signatures: Record<number, string> }>(`/api/campaigns/${campaignId}/release-signatures`, { beef })).signatures

  refundSignature = async (pledgeId: string, beef: string): Promise<{ inputIndex: number, signature: string }> =>
    await this.post(`/api/pledges/${encodeURIComponent(pledgeId)}/refund-signature`, { beef })

  /** Rebuild index entries from chain: AtomicBEEF, or plain BEEF (e.g. WhatsOnChain) plus its txid. */
  importTx = async (beef: string, txid?: string): Promise<{ txid: string, campaigns: string[], pledges: string[], skipped: string[] }> =>
    await this.post('/api/import', { beef, txid }, false)

  claimPledge = async (pledgeId: string, keyID: string, signature: string): Promise<void> => {
    await this.post(`/api/pledges/${encodeURIComponent(pledgeId)}/claim`, { keyID, signature })
  }

  /** Live feed (browser): EventSource on the campaign's SSE stream. */
  eventsUrl = (campaignId: string): string => `${this.baseUrl}/api/campaigns/${campaignId}/events`
}
