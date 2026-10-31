/**
 * Executing a giving routine: shared by the browser (the user approves each
 * run in their wallet) and the routine agent (agent/routineAgent.ts, which runs
 * delegated routines automatically from its own budget wallet).
 *
 * Both paths do exactly the same thing: pick the best open campaign for the
 * routine's target, convert the amount to sats at today's rate, check the
 * routine's limits, make a normal CryptoPledgePot escrow pledge with the given
 * wallet, and report the pledge so the server records the run (after its own
 * checks). Whoever's wallet makes the pledge is its donor.
 */
import type { CampaignView } from '../core/api'
import { checkRun, matchCampaigns, satsFor, type Routine, type RoutineCurrency, type RoutineRun } from '../core/routines'
import type { CryptoPledgePot } from './cryptoPledgePot'

/** Where runs are recorded: the server API, or the browser store in the offline demo. */
export interface RunRecorder { recordRun: (id: string, run: RoutineRun) => Promise<Routine> }

export const nowS = (): number => Math.floor(Date.now() / 1000)

// ───────────────────────────── exchange rates ─────────────────────────────

const rates = new Map<RoutineCurrency, { at: number, price: Promise<number | undefined> }>()
const RATE_TTL_S = 10 * 60

/** Fiat per 1 BSV, cached for 10 minutes. USD from WhatsOnChain, EUR from CoinGecko. Undefined if unreachable. */
export async function bsvPrice (currency: RoutineCurrency): Promise<number | undefined> {
  if (currency === 'SATS') return undefined
  const cached = rates.get(currency)
  if (cached !== undefined && nowS() - cached.at < RATE_TTL_S) return await cached.price
  const get = async (url: string, pick: (j: any) => unknown): Promise<number | undefined> => {
    try {
      const r = await fetch(url)
      const n = Number(pick(await r.json()))
      return r.ok && Number.isFinite(n) && n > 0 ? n : undefined
    } catch { return undefined }
  }
  const price = currency === 'USD'
    ? get('https://api.whatsonchain.com/v1/bsv/main/exchangerate', j => j.rate)
    : get('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin-cash-sv&vs_currencies=eur', j => j['bitcoin-cash-sv']?.eur)
  rates.set(currency, { at: nowS(), price })
  // A failed lookup is not cached: the next run tries again.
  void price.then(p => { if (p === undefined) rates.delete(currency) })
  return await price
}

// ─────────────────────────────── execution ───────────────────────────────

export interface RunPlan { campaign: CampaignView, sats: number, price?: number }

/** What a run of this routine would do right now: which campaign, how many sats. Throws if it can't run. */
export async function planRun (r: Routine, campaigns: CampaignView[], price = bsvPrice): Promise<RunPlan> {
  const best = matchCampaigns(r.target, campaigns, nowS())[0]
  if (best === undefined) throw new Error(`No open campaign matches "${r.target.label}" right now (looked for: ${r.target.keywords.slice(0, 6).join(', ')}).`)
  const p = await price(r.amount.currency)
  const sats = satsFor(r.amount, p)
  checkRun(r, sats, nowS())
  return { campaign: best.campaign, sats, price: p }
}

/**
 * Execute one due routine: a normal pledge into the campaign's escrow from
 * `client`'s wallet, then report it. If reporting fails, the pledge still
 * exists on chain and in the campaign; only the routine's bookkeeping is missing.
 */
export async function executeRoutine (recorder: RunRecorder, client: CryptoPledgePot, r: Routine, plan: RunPlan): Promise<{ routine: Routine, txid: string, pledgeId: string }> {
  const pledge = await client.donate(plan.campaign.meta, plan.sats, { message: `Giving routine: ${r.target.label}`.slice(0, 280) })
  const routine = await recorder.recordRun(r.id, { at: nowS(), campaignId: plan.campaign.id, campaignTitle: plan.campaign.meta.title, sats: pledge.amount, pledgeId: pledge.id })
  return { routine, txid: pledge.id.split('.')[0], pledgeId: pledge.id }
}
