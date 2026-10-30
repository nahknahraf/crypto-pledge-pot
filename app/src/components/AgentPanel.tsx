/**
 * For campaigns run by an AI agent: what the agent is doing and where every
 * sat went. Reads the agent's public endpoint (meta.agentUrl) and lets anyone
 * top up the agent's fee float with a BRC-29 payment from their own wallet.
 */
import { useCallback, useEffect, useState } from 'react'
import { createBrc29Payment } from '../../../client/payments'
import { formatSats, short, WOC_TX } from '../format'
import { confirmSpend, useWallet } from '../wallet'

interface AgentStatus {
  identityKey: string
  mission: string
  balance: number
  spent: { calls: number, sats: number }
  lastOutcome: { action: string, reason?: string } | null
}
interface SpendEntry { milestone: number, topic: string, why: string, sats: number, txid?: string, at: number }

export function AgentPanel ({ agentUrl }: { agentUrl: string }) {
  const { connect, error: walletError } = useWallet()
  const [status, setStatus] = useState<AgentStatus>()
  const [ledger, setLedger] = useState<SpendEntry[]>([])
  const [error, setError] = useState<string>()
  const [topUp, setTopUp] = useState(5_000)
  const [msg, setMsg] = useState<{ ok: boolean, text: string }>()
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const [s, l] = await Promise.all([fetch(`${agentUrl}/api/agent`), fetch(`${agentUrl}/api/agent/ledger`)])
      setStatus(await s.json())
      setLedger(await l.json())
      setError(undefined)
    } catch { setError(`The agent's status page (${agentUrl}) is not reachable right now.`) }
  }, [agentUrl])

  useEffect(() => {
    void load()
    const t = setInterval(() => { void load() }, 10_000)
    return () => clearInterval(t)
  }, [load])

  async function sendTopUp () {
    if (status === undefined) return
    const bf = await connect()
    if (bf === undefined) return
    if (!confirmSpend(`Send ${formatSats(topUp)} to the agent for its transaction fees?`)) return
    setBusy(true)
    setMsg(undefined)
    try {
      const payment = await createBrc29Payment(bf.wallet, status.identityKey, topUp, 'Top up CryptoPledgePot agent fees')
      const res = await fetch(`${agentUrl}/api/agent/fund`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payment) })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
      setMsg({ ok: true, text: `Sent ${formatSats(topUp)} to the agent.` })
      void load()
    } catch (e) { setMsg({ ok: false, text: (e as Error).message }) } finally { setBusy(false) }
  }

  return (
    <div className="card agent">
      <h3>🤖 Run by an AI agent</h3>
      {error !== undefined && <p className="muted small">{error}</p>}
      {status !== undefined && (
        <>
          <p className="small">{status.mission}</p>
          <div className="stats">
            <div><strong>{formatSats(status.balance)}</strong><span>agent balance</span></div>
            <div><strong>{status.spent.calls}</strong><span>paid API calls</span></div>
            <div><strong>{formatSats(status.spent.sats)}</strong><span>spent on data</span></div>
          </div>
          {status.lastOutcome !== null && <p className="muted small">Last action: {status.lastOutcome.action}{status.lastOutcome.reason !== undefined ? `: ${status.lastOutcome.reason}` : ''}</p>}
          <p className="muted small">Agent identity <code title={status.identityKey}>{short(status.identityKey)}</code></p>
        </>
      )}
      <h4>Every payment it made</h4>
      {ledger.length === 0 && <p className="muted small">No purchases yet.</p>}
      <ul className="ledger">
        {[...ledger].reverse().map((e, i) => (
          <li key={`${e.txid ?? ''}${i}`}>
            <span>M{e.milestone} · {e.topic}</span>
            <span>{formatSats(e.sats)}</span>
            {e.txid !== undefined ? <a href={WOC_TX + e.txid} target="_blank" rel="noreferrer">{short(e.txid)}</a> : <span className="muted">dry run</span>}
          </li>
        ))}
      </ul>
      {status !== undefined && (
        <div className="row">
          <input type="number" min={100} value={topUp} onChange={e => setTopUp(Math.floor(Number(e.target.value)))} style={{ width: '8rem' }} />
          <button disabled={busy} onClick={() => { void sendTopUp() }}>{busy ? 'Approve in wallet…' : 'Top up agent fees'}</button>
        </div>
      )}
      {walletError !== undefined && msg === undefined && <p className="err small">{walletError}</p>}
      {msg !== undefined && <p className={msg.ok ? 'ok small' : 'err small'}>{msg.text}</p>}
    </div>
  )
}
