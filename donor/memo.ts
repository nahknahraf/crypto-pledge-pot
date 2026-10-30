/**
 * Every decision the donor agent makes is a memo: what it looked at, what it
 * found, the score, and what it did (or proposes). Kept in an append-only
 * book (file-backed in production, in memory in tests).
 */
import type { Store } from '../agent/ledger'
import type { Check } from './diligence'
import type { Score } from './score'

export type MemoKind = 'pledge' | 'skip' | 'vote' | 'refund'
/**
 * proposed: co-pilot, waiting for the donor · executed: done on chain ·
 * declined: the donor said no · skipped: the agent decided against it · failed: an action errored
 */
export type MemoStatus = 'proposed' | 'executed' | 'declined' | 'skipped' | 'failed'

export interface Memo {
  id: string
  at: number
  kind: MemoKind
  status: MemoStatus
  campaignId: string
  campaignTitle: string
  /** One or two sentences for the donor. */
  summary: string
  /** Checks that passed and failed (hard rules and due diligence). */
  checks: Check[]
  reasons: string[]
  score?: Score
  /** Sats pledged or proposed (pledge), or reclaimed (refund). */
  amount?: number
  milestone?: number
  vote?: 'yes' | 'no' | 'abstain'
  pledgeId?: string
  txid?: string
  error?: string
}

export class MemoBook {
  constructor (private readonly store: Store<Memo[]>) {}

  all (): Memo[] { return this.store.load() }
  get (id: string): Memo | undefined { return this.all().find(m => m.id === id) }

  add (m: Omit<Memo, 'id' | 'at'>, now: number): Memo {
    const all = this.all()
    const memo: Memo = { ...m, id: `m${all.length + 1}`, at: now }
    this.store.save([...all, memo])
    return memo
  }

  update (id: string, patch: Partial<Memo>): Memo {
    const all = this.all()
    const i = all.findIndex(m => m.id === id)
    if (i < 0) throw new Error(`no memo ${id}`)
    all[i] = { ...all[i], ...patch, id: all[i].id, at: all[i].at }
    this.store.save(all)
    return all[i]
  }
}
