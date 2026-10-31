/**
 * Browser side of giving routines: where routines are stored, and how a due
 * routine turns into a pledge (the shared logic is in client/routineRunner.ts).
 *
 * Two stores behind one interface:
 *  - ServerRoutineStore: the CryptoPledgePot server (authenticated with the
 *    user's wallet, BRC-103). Routines follow the user across devices, and the
 *    server checks every reported run against the routine's limits.
 *  - LocalRoutineStore: browser storage, used only in the offline demo (where
 *    the wallet is never contacted). Runs there are simulated and marked so.
 *
 * Neither store can move money. Money moves only through a wallet:
 *  - manual runs: the user's own wallet, after the user confirmed;
 *  - automatic runs: the user's routine agent (agent/routineAgent.ts), from the
 *    budget the user moved into it, for routines the user delegated to it.
 */
import {
  applyRun, canSetStatus, checkRun, newRoutine, parseRoutineText,
  type ParseResult, type Routine, type RoutineDraft, type RoutineRun, type RoutineStatus
} from '../../core/routines'
import type { CryptoPledgePotApi } from '../../client/cryptoPledgePotApi'
import { nowS, type RunPlan } from '../../client/routineRunner'

export { bsvPrice, executeRoutine, planRun, type RunPlan } from '../../client/routineRunner'
export const now = nowS

/** Identity the offline demo uses for its simulated routine agent. */
export const DEMO_AGENT_KEY = '02' + 'de'.repeat(32)

export interface RoutineStore {
  readonly kind: 'server' | 'local'
  interpret: (text: string) => Promise<{ result: ParseResult, interpreter: string }>
  list: () => Promise<Routine[]>
  create: (draft: RoutineDraft) => Promise<Routine>
  setStatus: (id: string, status: RoutineStatus) => Promise<Routine>
  /** Delegate automatic execution to this identity key (the user's routine agent), or revoke it with null. */
  setExecutor: (id: string, identityKey: string | null) => Promise<Routine>
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
  setExecutor = async (id: string, identityKey: string | null) => await this.api.setRoutineExecutor(id, identityKey)
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

  setExecutor = async (id: string, identityKey: string | null) => this.update(id, r => ({ ...r, executor: identityKey === null ? null : { identityKey, since: now() } }))

  recordRun = async (id: string, run: RoutineRun) => this.update(id, r => { checkRun(r, run.sats, now()); return applyRun(r, run) })
}

/** Offline demo: the same plan, recorded as a simulated run (no wallet, no transaction). */
export async function simulateRoutine (store: RoutineStore, r: Routine, plan: RunPlan): Promise<Routine> {
  return await store.recordRun(r.id, { at: now(), campaignId: plan.campaign.id, campaignTitle: plan.campaign.meta.title, sats: plan.sats, pledgeId: `simulated-${now()}`, simulated: true })
}
