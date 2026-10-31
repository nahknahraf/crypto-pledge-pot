/**
 * Zero-click funding for the agents. A small TEAM treasury wallet (a server wallet, like each agent's own):
 *  1. hands out ONE deposit address of its own (client/receive.ts: a BRC-29 derived key, never P2PKH(identityKey));
 *     the team pays it once, from any wallet or exchange;
 *  2. claims what arrives, verified by SPV;
 *  3. tops up every agent with a BRC-29 payment to the identity key on its public status page, through the
 *     fund endpoint it already has. Nobody approves anything per agent.
 * It holds team money only (never a donor's), and only until it has funded the agents.
 */
import type { ChainTracker, WalletInterface } from '@bsv/sdk'
import { createBrc29Payment } from '../client/payments'
import { atomicBeefOf, claimReceived, paymentsTo, type ReceiveAddress } from '../client/receive'

export interface FundTarget {
  name: string
  /** Its public status page (GET): publishes its BSV identity key. */
  statusUrl: string
  /** Its BRC-29 top-up endpoint (POST). */
  fundUrl: string
  sats: number
}

export interface FundResult { name: string, ok: boolean, sats: number, txid?: string, error?: string }

/** The BSV identity key an agent publishes: fundraising agent, autopilot donor agent, or liquidity agent. */
export function identityFromStatus (status: any): string | undefined {
  const k = status?.identityKey ?? status?.wallet?.identityKey ?? status?.bsvIdentityKey
  return typeof k === 'string' && /^0[23][0-9a-f]{64}$/.test(k) ? k : undefined
}

/** Pay each target once. A failure is reported and the others still get funded. */
export async function fundAgents (wallet: WalletInterface, targets: FundTarget[], o: { fetchImpl?: typeof fetch, log?: (m: string) => void, originator?: string } = {}): Promise<FundResult[]> {
  const f = o.fetchImpl ?? fetch
  const log = o.log ?? (() => {})
  const out: FundResult[] = []
  for (const t of targets) {
    try {
      if (!Number.isSafeInteger(t.sats) || t.sats <= 0) throw new Error('amount must be a positive whole number of sats')
      const status = await (await f(t.statusUrl)).json()
      const key = identityFromStatus(status)
      if (key === undefined) throw new Error(`${t.statusUrl} publishes no BSV identity key (is it running, and in autopilot?)`)
      const payment = await createBrc29Payment(wallet, key, t.sats, `Treasury top-up: ${t.name}`.slice(0, 50), o.originator)
      const res = await f(t.fundUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payment) })
      const body = await res.json().catch(() => ({})) as { error?: string, txid?: string }
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
      out.push({ name: t.name, ok: true, sats: t.sats, txid: payment.txid })
      log(`funded ${t.name}: ${t.sats.toLocaleString('en-US')} sats (tx ${payment.txid.slice(0, 12)}…)`)
    } catch (e) {
      out.push({ name: t.name, ok: false, sats: t.sats, error: (e as Error).message })
      log(`could not fund ${t.name}: ${(e as Error).message}`)
    }
  }
  return out
}

/**
 * Claim every payment to the deposit address not claimed yet (SPV-checked). Returns the txids claimed now.
 * `claimed` is the caller's record of txids already taken (persist it across restarts).
 */
export async function claimDeposits (wallet: WalletInterface, address: ReceiveAddress, claimed: string[], o: { network: 'main' | 'test', chainTracker: ChainTracker, fetchBeef: (txid: string) => Promise<number[]>, listPayments?: (address: string) => Promise<string[]>, originator?: string }): Promise<Array<{ txid: string, sats: number }>> {
  const list = await (o.listPayments ?? (async a => await paymentsTo(a, o.network)))(address.address)
  const got: Array<{ txid: string, sats: number }> = []
  for (const txid of list.filter(t => !claimed.includes(t))) {
    const sats = await claimReceived(wallet, address, atomicBeefOf(await o.fetchBeef(txid), txid), o.chainTracker, o.originator)
    if (sats > 0) got.push({ txid, sats })
  }
  return got
}
