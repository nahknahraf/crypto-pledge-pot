/**
 * Due diligence that needs the network. Each check returns ok + a reason for
 * the memo. Data may come from the CryptoPledgePot server, but anything that
 * matters is verified independently: the anchor transaction by SPV against a
 * header source the agent chooses (Arcade on mainnet).
 */
import { Transaction, Utils, type ChainTracker } from '@bsv/sdk'
import type { CampaignView } from '../core/api'
import { campaignIdOf, parseCryptoPledgePotRecord } from '../core/campaign'
import type { CryptoPledgePotApi } from '../client/cryptoPledgePotApi'

export interface Check { name: string, ok: boolean, detail: string }

export interface DiligenceDeps {
  api: CryptoPledgePotApi
  /** Independent header source for SPV (ArcadeChainTracker on mainnet). */
  chainTracker: ChainTracker
  /** Does a transaction exist on chain? (WhatsOnChain on mainnet.) */
  txExists: (txid: string) => Promise<boolean>
  fetchImpl?: typeof fetch
}

/** The campaign's anchor transaction carries exactly this campaign's record and passes SPV. */
export async function checkAnchor (c: CampaignView, d: DiligenceDeps): Promise<Check> {
  const name = 'anchored on chain'
  try {
    const tx = Transaction.fromAtomicBEEF(Utils.toArray(await d.api.txBeef(c.anchorTxid), 'hex'))
    if (tx.id('hex') !== c.anchorTxid) return { name, ok: false, detail: 'the anchor transaction id does not match' }
    const record = tx.outputs.map(o => parseCryptoPledgePotRecord(o.lockingScript)).find(r => r?.kind === 'campaign')
    if (record?.kind !== 'campaign' || record.campaignId !== c.id || campaignIdOf(record.meta) !== c.id) {
      return { name, ok: false, detail: 'the anchor does not carry this campaign\'s terms' }
    }
    if (!(await tx.verify(d.chainTracker))) return { name, ok: false, detail: 'the anchor failed SPV verification' }
    return { name, ok: true, detail: `anchor ${c.anchorTxid.slice(0, 12)}… verified by SPV` }
  } catch (e) {
    return { name, ok: false, detail: `anchor could not be verified: ${(e as Error).message}` }
  }
}

/** The escrow's arbiter key is this server's (otherwise no milestone could ever be released here). */
export async function checkArbiter (c: CampaignView, d: DiligenceDeps): Promise<Check> {
  const name = 'arbiter is this platform\'s'
  try {
    const expected = await d.api.arbiterKey(c.meta.nonce, c.protocolTag)
    return expected === c.meta.arbiterKey
      ? { name, ok: true, detail: 'escrow arbiter matches the platform' }
      : { name, ok: false, detail: 'the escrow names a different arbiter' }
  } catch (e) {
    return { name, ok: false, detail: `arbiter could not be checked: ${(e as Error).message}` }
  }
}

/** For AI-agent campaigns: the agent's status page answers and its ledger is consistent. Not fatal: a risk flag if not. */
export async function checkAgent (c: CampaignView, d: DiligenceDeps): Promise<Check | undefined> {
  if (c.meta.kind !== 'agent') return undefined
  const name = 'AI agent is transparent'
  const url = c.meta.agentUrl
  if (url === undefined) return { name, ok: false, detail: 'no public status page' }
  try {
    const f = d.fetchImpl ?? fetch
    const [s, l] = await Promise.all([f(`${url}/api/agent`), f(`${url}/api/agent/ledger`)])
    if (!s.ok || !l.ok) return { name, ok: false, detail: 'status page not reachable' }
    const ledger = await l.json() as Array<{ sats: number, txid?: string }>
    const unreceipted = ledger.filter(e => e.sats > 0 && (e.txid === undefined || !/^[0-9a-f]{64}$/.test(e.txid)))
    if (unreceipted.length > 0) return { name, ok: false, detail: `${unreceipted.length} payment(s) without a transaction id` }
    return { name, ok: true, detail: `status page live; ${ledger.length} receipted payment(s)` }
  } catch {
    return { name, ok: false, detail: 'status page not reachable' }
  }
}

/** Transaction links in a report (WhatsOnChain URLs) that really exist. Other links are never fetched. */
export async function verifiedPaymentsIn (report: string, d: DiligenceDeps): Promise<{ linked: number, verified: number }> {
  const txids = [...new Set([...report.matchAll(/whatsonchain\.com\/tx\/([0-9a-f]{64})/gi)].map(m => m[1].toLowerCase()))].slice(0, 20)
  let verified = 0
  for (const t of txids) if (await d.txExists(t).catch(() => false)) verified++
  return { linked: txids.length, verified }
}
