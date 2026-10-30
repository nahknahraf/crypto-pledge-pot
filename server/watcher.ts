/**
 * Chain watcher: keeps the index honest without anyone reporting.
 *
 * Every round it asks the chain whether each active escrow output has been
 * spent. For each spend it fetches the spending transaction (with proofs) and
 * runs it through recordSpend(): the same SPV-checked path as POST /api/spends.
 * A donor who reclaims with another tool, or a release whose report got lost,
 * still ends up in the index.
 *
 * Unconfirmed spends may have no BEEF on WhatsOnChain yet (HTTP 422); they are
 * simply picked up in a later round once mined.
 */
import { Transaction, Utils } from '@bsv/sdk'
import { wocBeef } from '../client/cryptoPledgePot'
import type { CryptoPledgePotService } from './app'
import type { CryptoPledgePotDb } from './db'

export interface SpendSource {
  /** txid of the transaction that spent txid:vout, or undefined if unspent. */
  spentBy: (txid: string, vout: number) => Promise<string | undefined>
  /** The spending transaction as BEEF or AtomicBEEF hex. */
  beef: (txid: string) => Promise<string>
}

export function wocSpendSource (network: 'main' | 'test', pauseMs = 350): SpendSource {
  const base = `https://api.whatsonchain.com/v1/bsv/${network}`
  const pause = async (): Promise<void> => await new Promise(resolve => setTimeout(resolve, pauseMs)) // free-tier rate limit
  return {
    spentBy: async (txid, vout) => {
      await pause()
      const res = await fetch(`${base}/tx/${txid}/${vout}/spent`)
      if (res.status === 404) return undefined
      if (!res.ok) throw new Error(`WhatsOnChain spent lookup HTTP ${res.status}`)
      return (await res.json()).txid
    },
    beef: async (txid) => { await pause(); return await wocBeef(txid, network) }
  }
}

export interface WatchRound { checked: number, recorded: string[], pending: string[] }

export async function checkSpends (db: CryptoPledgePotDb, service: Pick<CryptoPledgePotService, 'recordSpend'>, source: SpendSource): Promise<WatchRound> {
  const round: WatchRound = { checked: 0, recorded: [], pending: [] }
  const seen = new Set<string>()
  for (const p of await db.activePledges()) {
    round.checked++
    const [txid, vout] = p.outpoint.split('.')
    const spender = await source.spentBy(txid, Number(vout))
    if (spender === undefined || seen.has(spender)) continue
    seen.add(spender) // one release can spend many escrows; record it once
    try {
      const raw = Utils.toArray(await source.beef(spender), 'hex')
      let tx: Transaction
      try { tx = Transaction.fromAtomicBEEF(raw) } catch { tx = Transaction.fromBEEF(raw, spender) }
      await service.recordSpend(tx, Array.from(tx.toAtomicBEEF()))
      round.recorded.push(spender)
    } catch (e) {
      // Not provable yet (e.g. unconfirmed, no BEEF), or already recorded by a report.
      if (!/no active CryptoPledgePot pledge/.test((e as Error).message)) round.pending.push(`${spender}: ${(e as Error).message}`)
    }
  }
  return round
}

/** Run checkSpends every intervalMs; never overlaps itself; logs only when something happened. */
export function startWatcher (db: CryptoPledgePotDb, service: Pick<CryptoPledgePotService, 'recordSpend'>, source: SpendSource, intervalMs: number, log = console.log): () => void {
  let running = false
  const tick = async (): Promise<void> => {
    if (running) return
    running = true
    try {
      const r = await checkSpends(db, service, source)
      if (r.recorded.length > 0 || r.pending.length > 0) log(`[watcher] checked ${r.checked} escrows · recorded ${r.recorded.length} spends${r.pending.length > 0 ? ` · pending: ${r.pending.join('; ')}` : ''}`)
    } catch (e) {
      log(`[watcher] round failed: ${(e as Error).message}`)
    } finally { running = false }
  }
  void tick()
  const timer = setInterval(() => { void tick() }, intervalMs)
  return () => clearInterval(timer)
}
