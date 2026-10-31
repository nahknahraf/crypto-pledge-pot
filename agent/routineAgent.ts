/**
 * The routine agent: runs a user's giving routines automatically, so they
 * don't have to approve every monthly gift by hand.
 *
 * Why this is not custody (see docs/AGENT_ROUTINES_NOTES.md §7):
 *  - It runs on the USER's machine, with its own wallet (its own root key).
 *    It never sees the user's keys, and the platform server holds no key to it.
 *  - It can only spend what the user moved into it ("Top up"). That budget is
 *    the outer limit; the user can take the rest back at any time ("Withdraw",
 *    which can only pay the agent's owner).
 *  - It only runs routines the owner delegated to it (`executor` = this
 *    agent's identity key, set by the owner's own authenticated request), and
 *    only within each routine's limits. The server re-checks every run, and
 *    the owner can revoke the delegation at any time.
 *  - Every run is a normal escrow pledge: released milestone by milestone, and
 *    refundable to this agent's wallet if the campaign fails.
 *
 * One step: list delegated routines → for each due one, plan (campaign + sats
 * at today's rate) → check the per-step and budget limits → pledge → report.
 */
import type { CampaignView } from '../core/api'
import { isDue, type Routine } from '../core/routines'
import type { CryptoPledgePot } from '../client/cryptoPledgePot'
import type { CryptoPledgePotApi } from '../client/cryptoPledgePotApi'
import { bsvPrice, executeRoutine, nowS, planRun } from '../client/routineRunner'
import type { Store } from './ledger'

export interface RoutineAgentActivity {
  at: number
  routineId: string
  label: string
  kind: 'paid' | 'skipped' | 'failed'
  text: string
  sats?: number
  txid?: string
  campaignId?: string
}

export interface RoutineAgentState {
  /** The user this agent works for: the identity that first funded it. Withdrawals only go there. */
  ownerIdentityKey: string | null
  activity: RoutineAgentActivity[]
}

export interface RoutineAgentDeps {
  /** API authenticated as the agent's own wallet (lists delegated routines, reports runs). */
  api: CryptoPledgePotApi
  /** Pledges from the agent's own wallet. */
  client: CryptoPledgePot
  /** Spendable satoshis in the agent's wallet. */
  balance: () => Promise<number>
  state: Store<RoutineAgentState>
  price?: typeof bsvPrice
  /** Safety valve independent of the routines: at most this many sats per step (default 1,000,000). */
  maxSatsPerStep?: number
  log?: (line: string) => void
}

export interface RoutineStepSummary { delegated: number, due: number, paid: number, skipped: number, failed: number, sats: number }

/** Sats the wallet should keep for the network fee of a pledge (~350 sats measured; generous). */
const FEE_RESERVE = 1_000
const MAX_ACTIVITY = 200

export class RoutineAgent {
  constructor (readonly deps: RoutineAgentDeps) {}

  get state (): RoutineAgentState { return this.deps.state.load() }

  private record (a: RoutineAgentActivity): void {
    const s = this.deps.state.load()
    this.deps.state.save({ ...s, activity: [...s.activity, a].slice(-MAX_ACTIVITY) })
    this.deps.log?.(`[routines] ${a.kind}: ${a.label}: ${a.text}${a.txid !== undefined ? ` tx ${a.txid}` : ''}`)
  }

  /** The first funder becomes the owner; later top-ups must come from the same identity. */
  claimOwner (identityKey: string): void {
    const s = this.deps.state.load()
    if (s.ownerIdentityKey === null) this.deps.state.save({ ...s, ownerIdentityKey: identityKey })
    else if (s.ownerIdentityKey !== identityKey) throw new Error('this routine agent already belongs to another identity')
  }

  async step (): Promise<RoutineStepSummary> {
    const summary: RoutineStepSummary = { delegated: 0, due: 0, paid: 0, skipped: 0, failed: 0, sats: 0 }
    const owner = this.state.ownerIdentityKey
    const routines = await this.deps.api.delegatedRoutines()
    summary.delegated = routines.length
    // Only the owner's routines: someone else delegating to this agent's key must not get to spend its budget.
    const due = routines.filter(r => isDue(r, nowS()) && owner !== null && r.owner.scheme === 'brc103' && r.owner.identityKey === owner)
    summary.due = due.length
    if (due.length === 0) return summary

    let campaigns: CampaignView[]
    try { campaigns = await this.deps.api.campaigns() } catch (e) {
      summary.failed = due.length
      this.deps.log?.(`[routines] cannot list campaigns: ${(e as Error).message}`)
      return summary
    }
    const cap = this.deps.maxSatsPerStep ?? 1_000_000
    for (const r of due) {
      const label = r.target.label
      try {
        const plan = await planRun(r, campaigns, this.deps.price ?? bsvPrice)
        if (summary.sats + plan.sats > cap) { this.skip(r, summary, `would exceed this agent's limit of ${cap} sats per round; next round`); continue }
        const balance = await this.deps.balance()
        if (plan.sats + FEE_RESERVE > balance) { this.skip(r, summary, `budget too low: needs ${plan.sats} sats + fee, has ${balance}. Top up the agent.`); continue }
        const { txid } = await executeRoutine({ recordRun: async (id, run) => await this.deps.api.recordRoutineRun(id, run.pledgeId) }, this.deps.client, r, plan)
        summary.paid++
        summary.sats += plan.sats
        this.record({ at: nowS(), routineId: r.id, label, kind: 'paid', sats: plan.sats, txid, campaignId: plan.campaign.id, text: `${plan.sats} sats into the escrow of "${plan.campaign.meta.title}"` })
      } catch (e) {
        // No match, no exchange rate, or a limit: wait for the next round. Anything else is a failure.
        const msg = (e as Error).message
        if (/No open campaign|exchange rate|cap|not due/.test(msg)) this.skip(r, summary, msg)
        else { summary.failed++; this.record({ at: nowS(), routineId: r.id, label, kind: 'failed', text: msg }) }
      }
    }
    return summary
  }

  private skip (r: Routine, summary: RoutineStepSummary, text: string): void {
    summary.skipped++
    // Don't repeat the same skip reason every minute: only log it when it changes.
    const last = [...this.state.activity].reverse().find(a => a.routineId === r.id)
    if (last?.kind === 'skipped' && last.text === text) return
    this.record({ at: nowS(), routineId: r.id, label: r.target.label, kind: 'skipped', text })
  }
}
