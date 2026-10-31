/**
 * The agent's spending log and its small amount of persistent state.
 *
 * Every paid API call is recorded with its txid, so backers can check where
 * their money went, call by call, on WhatsOnChain. File-backed in production
 * (data/agent-ledger.json, data/agent-state.json), in-memory in tests.
 */
import type { City } from '../data-provider/dataProvider'
import type { Store } from '../shared/store'

export interface SpendEntry {
  milestone: number
  topic: City
  why: string
  url: string
  sats: number
  txid?: string
  at: number
  /** Paid, but the provider delivered nothing. The sats still count against the limits. */
  failed?: boolean
}

export interface AgentState {
  campaignId?: string
  /** Milestones whose released funds have already been spent on work. */
  worked: number[]
}

// The generic store lives in shared/; re-exported for the fundraising agent's own modules and tests.
export { fileStore, memoryStore, type Store } from '../shared/store'

export class Ledger {
  constructor (private readonly store: Store<SpendEntry[]>) {}
  all (): SpendEntry[] { return this.store.load() }
  add (e: SpendEntry): void { this.store.save([...this.store.load(), e]) }
  forMilestone (m: number): SpendEntry[] { return this.all().filter(e => e.milestone === m) }
  totals (): { calls: number, sats: number } {
    const all = this.all()
    return { calls: all.length, sats: all.reduce((s, e) => s + e.sats, 0) }
  }
}
