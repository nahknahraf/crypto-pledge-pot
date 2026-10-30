/**
 * Browser side of giving routines: where routines are stored, exchange rates,
 * and how a due routine turns into a pledge.
 *
 * Two stores behind one interface:
 *  - ServerRoutineStore: the CryptoPledgePot server (authenticated with the
 *    user's wallet, BRC-103). Routines follow the user across devices, and the
 *    server checks every reported run against the routine's limits.
 *  - LocalRoutineStore: browser storage, used only in the offline demo (where
 *    the wallet is never contacted). Runs there are simulated and marked so.
 *
 * Neither store can move money. Only `executeRoutine` does, and only through
 * the user's own wallet (`CryptoPledgePot.donate`), after the user confirmed.
 */
import type { CampaignView } from '../../core/api'
import {
  applyRun, canSetStatus, checkRun, matchCampaigns, newRoutine, parseRoutineText, satsFor,
  type ParseResult, type Routine, type RoutineCurrency, type RoutineDraft, type RoutineRun, type RoutineStatus
} from '../../core/routines'
import type { CryptoPledgePot } from '../../client/cryptoPledgePot'
import type { CryptoPledgePotApi } from '../../client/cryptoPledgePotApi'

export interface RoutineStore {
  readonly kind: 'server' | 'local'
  interpret: (text: string) => Promise<{ result: ParseResult, interpreter: string }>
  list: () => Promise<Routine[]>
  create: (draft: RoutineDraft) => Promise<Routine>
  setStatus: (id: string, status: RoutineStatus) => Promise<Routine>
  /** Record an execution. The server only needs the pledge id; it reads the rest from its own index. */
  recordRun: (id: string, run: RoutineRun) => Promise<Routine>
}

export class ServerRoutineStore implements RoutineStore {
  readonly kind = 'server'
  constructor (private readonly api: CryptoPledgePotApi) {}
  interpret = async (text: string) => await this.api.interpretRoutine(text)
  list = async () => await this.api.routines()
  create = async (draft: RoutineDraft) => await this.api.createRoutine(draft)
  setStatus = async (id: string, status: RoutineStatus) => await this.api.setRoutineStatus(id, status)
  recordRun = async (id: string, run: RoutineRun) => await this.api.recordRoutineRun(id, run.pledgeId)
}

/** Offline demo only. Applies the same core rules as the server, on data kept in this browser. */
export class LocalRoutineStore implements RoutineStore {
  readonly kind = 'local'
  private static readonly KEY = 'cryptopledgepot.routines.demo'
  private readonly owner = { scheme: 'brc103' as const, identityKey: 'offline-demo' }

  private load (): Routine[] {
    try { return JSON.parse(localStorage.getItem(LocalRoutineStore.KEY) ?? '[]') } catch { return [] }
  }

  private save (all: Routine[]): void {
    try { localStorage.setItem(LocalRoutineStore.KEY, JSON.stringify(all)) } catch { /* private mode: keep it in memory for this page only */ }
  }

  private update (id: string, fn: (r: Routine) => Routine): Routine {
    const all = this.load()
    const i = all.findIndex(r => r.id === id)
    if (i < 0) throw new Error('routine not found')
    all[i] = fn(all[i])
    this.save(all)
    return all[i]
  }

  interpret = async (text: string) => ({ result: parseRoutineText(text), interpreter: 'rules (in this browser)' })
  list = async () => this.load().sort((a, b) => b.createdAt - a.createdAt)
  create = async (draft: RoutineDraft) => {
    const r = newRoutine(crypto.randomUUID().replace(/-/g, ''), this.owner, draft, now())
    this.save([r, ...this.load()])
    return r
  }

  setStatus = async (id: string, status: RoutineStatus) => this.update(id, r => {
    if (!canSetStatus(r.status, status)) throw new Error(`cannot change a ${r.status} routine to ${status}`)
    return { ...r, status, nextRunAt: status === 'cancelled' ? null : status === 'active' ? Math.min(r.nextRunAt ?? now(), now()) : r.nextRunAt }
  })

  recordRun = async (id: string, run: RoutineRun) => this.update(id, r => { checkRun(r, run.sats, now()); return applyRun(r, run) })
}

export const now = (): number => Math.floor(Date.now() / 1000)

// ───────────────────────────── exchange rates ─────────────────────────────

const rates = new Map<RoutineCurrency, Promise<number | undefined>>()

/** Fiat per 1 BSV (cached per page load). USD from WhatsOnChain, EUR from CoinGecko. Undefined if unreachable. */
export async function bsvPrice (currency: RoutineCurrency): Promise<number | undefined> {
  if (currency === 'SATS') return undefined
  if (!rates.has(currency)) {
    const get = async (url: string, pick: (j: any) => unknown): Promise<number | undefined> => {
      try {
        const r = await fetch(url)
        const n = Number(pick(await r.json()))
        return r.ok && Number.isFinite(n) && n > 0 ? n : undefined
      } catch { return undefined }
    }
    rates.set(currency, currency === 'USD'
      ? get('https://api.whatsonchain.com/v1/bsv/main/exchangerate', j => j.rate)
      : get('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin-cash-sv&vs_currencies=eur', j => j['bitcoin-cash-sv']?.eur))
  }
  return await rates.get(currency)!
}

// ─────────────────────────────── execution ───────────────────────────────

export interface RunPlan { campaign: CampaignView, sats: number, price?: number }

/** What a run of this routine would do right now: which campaign, how many sats. Throws if it can't run. */
export async function planRun (r: Routine, campaigns: CampaignView[]): Promise<RunPlan> {
  const best = matchCampaigns(r.target, campaigns, now())[0]
  if (best === undefined) throw new Error(`No open campaign matches "${r.target.label}" right now (looked for: ${r.target.keywords.slice(0, 6).join(', ')}).`)
  const price = await bsvPrice(r.amount.currency)
  const sats = satsFor(r.amount, price)
  checkRun(r, sats, now())
  return { campaign: best.campaign, sats, price }
}

/**
 * Execute one due routine with the user's wallet: a normal pledge into the
 * campaign's escrow (one wallet approval), then report it so the routine's
 * history shows it. If reporting fails, the pledge still exists on chain and
 * in the campaign; only the routine's bookkeeping is missing.
 */
export async function executeRoutine (store: RoutineStore, client: CryptoPledgePot, r: Routine, plan: RunPlan): Promise<{ routine: Routine, txid: string }> {
  const pledge = await client.donate(plan.campaign.meta, plan.sats, { message: `Giving routine: ${r.target.label}`.slice(0, 280) })
  const routine = await store.recordRun(r.id, { at: now(), campaignId: plan.campaign.id, campaignTitle: plan.campaign.meta.title, sats: pledge.amount, pledgeId: pledge.id })
  return { routine, txid: pledge.id.split('.')[0] }
}

/** Offline demo: the same plan, recorded as a simulated run (no wallet, no transaction). */
export async function simulateRoutine (store: RoutineStore, r: Routine, plan: RunPlan): Promise<Routine> {
  return await store.recordRun(r.id, { at: now(), campaignId: plan.campaign.id, campaignTitle: plan.campaign.meta.title, sats: plan.sats, pledgeId: `simulated-${now()}`, simulated: true })
}
