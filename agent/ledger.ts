/**
 * The agent's spending log and its small amount of persistent state.
 *
 * Every paid API call is recorded with its txid, so backers can check where
 * their money went, call by call, on WhatsOnChain. File-backed in production
 * (data/agent-ledger.json, data/agent-state.json), in-memory in tests.
 */
import fs from 'node:fs'
import path from 'node:path'
import type { City } from './dataProvider'

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

export interface Store<T> { load: () => T, save: (value: T) => void }

export const memoryStore = <T>(initial: T): Store<T> => {
  let value = structuredClone(initial)
  return { load: () => structuredClone(value), save: v => { value = structuredClone(v) } }
}

export const fileStore = <T>(file: string, initial: T): Store<T> => ({
  load: () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T } catch { return structuredClone(initial) } },
  save: v => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(v, null, 2))
    fs.renameSync(tmp, file) // atomic replace: a crash never leaves half a ledger
  }
})

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
