/**
 * The user's routine agent, as seen from the Giving routines page: is it
 * running, how much budget it has, what it did. Top up and withdraw move sats
 * between the user's wallet and the agent's wallet with BRC-29 payments; the
 * agent can only ever pay back to its owner.
 *
 * The agent runs on the user's machine (npm run routine-agent) and is reached
 * at /routine-agent through the LOCAL dev server only. In the offline demo a
 * simulated agent stands in for it.
 */
import { useState } from 'react'
import { acceptBrc29Payment, createBrc29Payment, type Brc29Payment } from '../../../client/payments'
import { dateTime, formatSats, short, WOC_TX } from '../format'
import { confirmSpend, useWallet } from '../wallet'
import { Notice } from './ui'

export interface AgentActivity { at: number, routineId: string, label: string, kind: 'paid' | 'skipped' | 'failed', text: string, sats?: number, txid?: string, campaignId?: string }

export interface AgentStatus {
  identityKey: string
  balance: number
  ownerIdentityKey: string | null
  activity: AgentActivity[]
  /** Offline demo: a stand-in that simulates runs, no wallet. */
  simulated?: boolean
}

export const agentApi = async <T,>(path: string, body?: unknown): Promise<T> => {
  const res = await fetch(`/routine-agent${path}`, body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const json = await res.json()
  if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`)
  return json
}

export function RoutineAgentCard ({ agent, autoCount, onChange }: { agent: AgentStatus | null | undefined, autoCount: number, onChange: () => void }) {
  const { connect, identityKey } = useWallet()
  const [topUp, setTopUp] = useState(20_000)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean, text: string }>()

  async function act (fn: () => Promise<string>) {
    setBusy(true); setMsg(undefined)
    try { setMsg({ ok: true, text: await fn() }); onChange() } catch (e) { setMsg({ ok: false, text: (e as Error).message }) } finally { setBusy(false) }
  }

  if (agent === undefined) return <div className="card"><p className="muted small">Looking for your routine agent…</p></div>
  if (agent === null) {
    return (
      <div className="card">
        <h3>Automatic giving: your routine agent</h3>
        <p className="small">
          To run routines without approving each gift, start your own routine agent on this computer. It gets its own wallet,
          and you move a budget into it. It can only spend that budget, only on routines you switch to <strong>Automatic</strong>,
          and only within their caps. Your own wallet's keys never leave your wallet.
        </p>
        <pre className="small">npm run routine-agent</pre>
        <p className="muted small">Not running, or this page is not served by your local dev server (the agent is never reachable through a public link).</p>
      </div>
    )
  }

  const foreignOwner = agent.ownerIdentityKey !== null && identityKey !== undefined && agent.ownerIdentityKey !== identityKey
  return (
    <div className="card">
      <div className="row between">
        <h3>Automatic giving: your routine agent</h3>
        <span className="badge agent">{agent.simulated === true ? 'Simulated' : 'Running'}</span>
      </div>
      <p className="small">
        Runs {autoCount} routine{autoCount === 1 ? '' : 's'} automatically from its own budget.
        {agent.simulated !== true && <> Agent wallet <span title={agent.identityKey}>{short(agent.identityKey)}</span>.</>}
      </p>
      <p className="small"><strong>Budget: {formatSats(agent.balance)}</strong>{agent.simulated === true ? ' (simulated)' : ''}. It can never spend more than this, and you can take it back at any time.</p>
      {foreignOwner && <Notice kind="err">This agent belongs to another identity ({short(agent.ownerIdentityKey!)}). Connect that wallet, or run your own agent.</Notice>}
      {agent.simulated !== true && !foreignOwner && (
        <div className="row">
          <input type="number" min={1000} value={topUp} onChange={e => setTopUp(Math.floor(Number(e.target.value)))} style={{ width: '8rem' }} aria-label="Top-up amount in sats" />
          <button disabled={busy} onClick={() => {
            void act(async () => {
              const client = await connect()
              if (client === undefined) throw new Error('Could not connect your wallet. Open and unlock BSV Desktop, then try again.')
              if (!confirmSpend(`Move ${formatSats(topUp)} into your routine agent's budget? It will use it only for routines you set to Automatic.`)) return 'Cancelled.'
              await agentApi('/api/routine-agent/fund', await createBrc29Payment(client.wallet, agent.identityKey, topUp, 'Routine agent budget'))
              return `Moved ${formatSats(topUp)} to your routine agent.`
            })
          }}>Top up budget</button>
          <button className="secondary" disabled={busy || agent.balance < 1000 || agent.ownerIdentityKey === null} onClick={() => {
            void act(async () => {
              const client = await connect()
              if (client === undefined) throw new Error('Could not connect your wallet.')
              if (!window.confirm(`Take the agent's budget (${formatSats(agent.balance)}, minus the fee) back into your wallet? Automatic routines pause until you top it up again.`)) return 'Kept.'
              const payment = await agentApi<Brc29Payment>('/api/routine-agent/withdraw', { satoshis: 'all' })
              await acceptBrc29Payment(client.wallet, payment, undefined, 'Routine agent budget returned')
              return `${formatSats(payment.satoshis)} are back in your wallet.`
            })
          }}>Withdraw all</button>
          <button className="secondary" disabled={busy} onClick={() => { void act(async () => { const s = await agentApi<{ paid: number, due: number }>('/api/routine-agent/step', {}); return `Checked now: ${s.due} due, ${s.paid} paid.` }) }}>Run check now</button>
        </div>
      )}
      {msg !== undefined && <Notice kind={msg.ok ? 'ok' : 'err'}>{msg.text}</Notice>}
      {agent.activity.length > 0 && (
        <details className="small" open>
          <summary>What it did ({agent.activity.length})</summary>
          <ul className="activity">
            {agent.activity.slice(0, 10).map((a, i) => (
              <li key={i} className={a.kind}>
                {dateTime(a.at)} · <strong>{a.label}</strong>: {a.text}{' '}
                {a.txid !== undefined && <a href={WOC_TX + a.txid} target="_blank" rel="noreferrer">{short(a.txid)}</a>}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}
