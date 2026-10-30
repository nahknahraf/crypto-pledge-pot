/**
 * "My donor agent": the donor's view of their own agent (it runs on their
 * machine; this page reaches it at /donor via the local dev server).
 *
 * Co-pilot: proposals wait here with a short memo; "Approve & pay" pays from
 * the donor's own wallet, then tells the agent which pledge it was (the agent
 * verifies it). Autopilot: read-only record of what the agent did, plus a
 * budget top-up. Both: "Find campaigns" searches from a few words.
 */
import { useCallback, useEffect, useState } from 'react'
import { createBrc29Payment } from '../../../client/payments'
import { Notice } from '../components/ui'
import { formatSats, short, WOC_TX } from '../format'
import { api, confirmSpend, useWallet } from '../wallet'

interface Check { name: string, ok: boolean, detail: string }
interface Memo {
  id: string, at: number, kind: 'pledge' | 'skip' | 'vote' | 'refund', status: string, campaignId: string, campaignTitle: string,
  summary: string, checks: Check[], reasons: string[], score?: { total: number }, amount?: number, milestone?: number, vote?: string, pledgeId?: string, txid?: string, error?: string
}
interface Status {
  name: string, mode: 'autopilot' | 'copilot', interests: string, keywords: string[], brain: string, scoreThreshold: number,
  budget: { totalSats: number, perPledgeMaxSats: number, pledged: number, reserved: number, left: number, reclaimed: number },
  donorIdentityKey: string | null, wallet: { identityKey: string, balance: number | null } | null,
  counts: { proposals: number, pledges: number, skipped: number, votes: number, refunds: number }
}

interface Match {
  campaignId: string, title: string, relevance: number, why: string, summary: string, warnings: string[],
  facts: { raisedSats: number, goalSats: number, fundedPercent: number, donors: number, daysLeft: number, milestones: string[] }
}

/** "children in need" → the open campaigns that fit, each in a few lines. */
function FindCampaigns () {
  const [query, setQuery] = useState('')
  const [result, setResult] = useState<{ query: string, matches: Match[] }>()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  async function search (e: { preventDefault: () => void }) {
    e.preventDefault()
    setBusy(true); setError(undefined)
    try { setResult(await donorApi('/api/donor/search', { query })) } catch (err) { setError((err as Error).message) } finally { setBusy(false) }
  }
  return (
    <div className="card">
      <h2>Find campaigns</h2>
      <form className="row" onSubmit={e => { void search(e) }}>
        <input value={query} maxLength={200} placeholder="e.g. children in need, clean water, animals" onChange={e => setQuery(e.target.value)} style={{ flex: 1 }} />
        <button className="primary" disabled={busy || query.trim() === ''}>{busy ? 'Searching…' : 'Find'}</button>
      </form>
      {error !== undefined && <Notice kind="err">{error}</Notice>}
      {result !== undefined && result.matches.length === 0 && <p className="muted">Nothing open matches "{result.query}" right now.</p>}
      {result?.matches.map(m => (
        <div className="memo" key={m.campaignId}>
          <div className="row between"><a href={`#/c/${m.campaignId}`}><h3>{m.title}</h3></a><span className="score">{m.relevance}% match</span></div>
          <p>{m.summary}</p>
          <p className="muted small">{formatSats(m.facts.raisedSats)} of {formatSats(m.facts.goalSats)} ({m.facts.fundedPercent}%) · {m.facts.donors} donor(s) · {m.facts.daysLeft} day(s) left · {m.why}</p>
          {m.warnings.map((w, i) => <Notice key={i} kind="err">{w}</Notice>)}
        </div>
      ))}
    </div>
  )
}

const donorApi = async <T,>(path: string, body?: unknown): Promise<T> => {
  const res = await fetch(`/donor${path}`, body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const json = await res.json()
  if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`)
  return json
}

export function Donor () {
  const { connect, identityKey, serverNetwork } = useWallet()
  // connect() reports why it failed through state that isn't updated yet here, so say it directly.
  const noWallet = (): Error => new Error(serverNetwork === 'mock'
    ? 'This is the offline demo: wallet actions are disabled, so your real wallet is never contacted.'
    : 'Could not connect your wallet. Open and unlock BSV Desktop, then try again.')
  const [status, setStatus] = useState<Status>()
  const [memos, setMemos] = useState<Memo[]>([])
  const [offline, setOffline] = useState(false)
  const [busy, setBusy] = useState<string>()
  const [msg, setMsg] = useState<{ ok: boolean, text: string }>()
  const [topUp, setTopUp] = useState(10_000)

  const load = useCallback(async () => {
    try {
      setStatus(await donorApi<Status>('/api/donor'))
      setMemos(await donorApi<Memo[]>('/api/donor/memos'))
      setOffline(false)
    } catch { setOffline(true) }
  }, [])
  useEffect(() => { void load(); const t = setInterval(() => { void load() }, 5_000); return () => clearInterval(t) }, [load])

  async function act (id: string, fn: () => Promise<string>) {
    setBusy(id); setMsg(undefined)
    try { setMsg({ ok: true, text: await fn() }); await load() } catch (e) { setMsg({ ok: false, text: (e as Error).message }) } finally { setBusy(undefined) }
  }

  const approve = (m: Memo) => act(m.id, async () => {
    const client = await connect()
    if (client === undefined) throw noWallet()
    const me = await client.identityKey()
    if (status?.donorIdentityKey !== null && status?.donorIdentityKey !== undefined && status.donorIdentityKey !== me) {
      throw new Error('this wallet is not the one named in your agent\'s terms (donorIdentityKey)')
    }
    if (!confirmSpend(`Pledge ${formatSats(m.amount ?? 0)} to "${m.campaignTitle}", as your agent proposed?`)) return 'Cancelled.'
    const { meta } = await api.campaign(m.campaignId)
    const pledge = await client.donate(meta, m.amount!, {})
    await donorApi(`/api/donor/memos/${m.id}/approve`, { pledgeId: pledge.id })
    return `Paid ${formatSats(pledge.amount)} into "${m.campaignTitle}"'s escrow.`
  })

  if (offline) {
    return (
      <div className="card">
        <h1>My donor agent</h1>
        <p>Your donor agent isn't running. It runs on your own machine:</p>
        <pre className="small">cp donor-mandate.example.json data/donor-mandate.json   # set your budget and terms{'\n'}npm run donor</pre>
        <p className="muted small">In <strong>co-pilot</strong> mode it proposes and you approve every payment here. In <strong>autopilot</strong> it gives, votes and recovers money on its own, from a budget you move into its wallet.</p>
      </div>
    )
  }
  if (status === undefined) return <p className="muted">Loading…</p>

  const proposals = memos.filter(m => m.status === 'proposed')
  const done = memos.filter(m => m.status === 'executed' || m.status === 'declined' || m.status === 'failed' || (m.kind === 'vote' && m.status === 'skipped'))
  const skipped = memos.filter(m => m.kind === 'skip')
  const usedPct = (n: number): string => `${Math.min(100, (n / status.budget.totalSats) * 100)}%`

  return (
    <>
      <div className="card">
        <div className="row between">
          <h1>{status.name}</h1>
          <span className={`badge ${status.mode === 'autopilot' ? 'agent' : 'funded'}`}>{status.mode === 'autopilot' ? 'Autopilot' : 'Co-pilot'}</span>
        </div>
        <p className="small">{status.mode === 'autopilot'
          ? 'Your agent gives, checks milestone reports, votes and takes money back from failed campaigns on its own, within your terms.'
          : 'Your agent finds and checks campaigns and proposes pledges. Nothing is paid until you approve it here, from your own wallet.'}</p>
        <p className="muted small">Looking for: {status.interests || status.keywords.join(', ')} · pledges only at score ≥ {status.scoreThreshold} · max {formatSats(status.budget.perPledgeMaxSats)} per pledge · brain: {status.brain}</p>
        <div className="budget-bar"><div className="pledged" style={{ width: usedPct(status.budget.pledged) }} /><div className="reserved" style={{ width: usedPct(status.budget.reserved) }} /></div>
        <p className="small">{formatSats(status.budget.pledged)} given · {formatSats(status.budget.reserved)} proposed · <strong>{formatSats(status.budget.left)} left</strong> of {formatSats(status.budget.totalSats)}{status.budget.reclaimed > 0 && ` · ${formatSats(status.budget.reclaimed)} reclaimed`}</p>
        <div className="row">
          <button disabled={busy !== undefined} onClick={() => { void act('step', async () => { const s = await donorApi<Record<string, number>>('/api/donor/step', {}); return `Checked ${s.evaluated} new campaign(s): ${s.proposed} proposed, ${s.pledged} pledged, ${s.skipped} skipped, ${s.votes} vote(s), ${s.refunds} refund(s).` }) }}>Look for campaigns now</button>
          {status.wallet !== null && (
            <>
              <span className="muted small">Agent wallet {short(status.wallet.identityKey)}: {formatSats(status.wallet.balance ?? 0)}</span>
              <input type="number" min={100} value={topUp} onChange={e => setTopUp(Math.floor(Number(e.target.value)))} style={{ width: '8rem' }} />
              <button disabled={busy !== undefined} onClick={() => {
                void act('fund', async () => {
                  const client = await connect()
                  if (client === undefined) throw noWallet()
                  if (!confirmSpend(`Move ${formatSats(topUp)} into your donor agent's budget wallet?`)) return 'Cancelled.'
                  await donorApi('/api/donor/fund', await createBrc29Payment(client.wallet, status.wallet!.identityKey, topUp, 'Donor agent budget'))
                  return `Moved ${formatSats(topUp)} to your agent.`
                })
              }}>Top up budget</button>
            </>
          )}
        </div>
        {msg !== undefined && <Notice kind={msg.ok ? 'ok' : 'err'}>{msg.text}</Notice>}
        {identityKey === undefined && status.mode === 'copilot' && proposals.length > 0 && <p className="muted small">Connect your wallet to approve proposals.</p>}
      </div>

      <FindCampaigns />

      {status.mode === 'copilot' && (
        <>
          <h2>Waiting for your approval ({proposals.length})</h2>
          {proposals.length === 0 && <p className="muted">No open proposals. Your agent will put new ones here.</p>}
          {proposals.map(m => (
            <div className="card memo" key={m.id}>
              <div className="row between">
                <a href={`#/c/${m.campaignId}`}><h3>{m.campaignTitle}</h3></a>
                <span className="score">{m.score?.total ?? '–'}/100</span>
              </div>
              <p>{m.summary}</p>
              <ul className="small reasons">{m.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul>
              <details className="small"><summary>Checks ({m.checks.filter(c => c.ok).length}/{m.checks.length} passed)</summary>
                <ul className="checks">{m.checks.map((c, i) => <li key={i} className={c.ok ? 'ok' : 'err'}>{c.ok ? '✓' : '✗'} {c.detail}</li>)}</ul>
              </details>
              <div className="row">
                <button className="primary" disabled={busy !== undefined} onClick={() => { void approve(m) }}>{busy === m.id ? 'Approve in your wallet…' : `Approve & pay ${formatSats(m.amount ?? 0)}`}</button>
                <button className="secondary" disabled={busy !== undefined} onClick={() => { void act(m.id, async () => { await donorApi(`/api/donor/memos/${m.id}/decline`, {}); return `Declined "${m.campaignTitle}"; its budget is free again.` }) }}>Decline</button>
              </div>
            </div>
          ))}
        </>
      )}

      <h2>What your agent did ({done.length})</h2>
      {done.length === 0 && <p className="muted">Nothing yet.</p>}
      <ul className="memo-list">
        {done.map(m => (
          <li key={m.id} className={m.status}>
            <span className="tag">{m.kind === 'pledge' ? (m.status === 'declined' ? 'declined' : 'pledge') : m.kind === 'vote' ? `vote ${m.vote ?? ''}` : m.kind}</span>
            <a href={`#/c/${m.campaignId}`}>{m.campaignTitle}</a>
            <span>{m.amount !== undefined ? formatSats(m.amount) : ''}</span>
            <span className="muted small">{m.summary}{m.error !== undefined ? ` (${m.error})` : ''}</span>
            {m.txid !== undefined && <a className="small" href={WOC_TX + m.txid} target="_blank" rel="noreferrer">{short(m.txid)}</a>}
          </li>
        ))}
      </ul>

      <details className="card">
        <summary><strong>Campaigns your agent skipped ({skipped.length})</strong> and why</summary>
        <ul className="memo-list">
          {skipped.map(m => (
            <li key={m.id}><a href={`#/c/${m.campaignId}`}>{m.campaignTitle}</a><span className="muted small">{m.reasons[0]}</span></li>
          ))}
        </ul>
      </details>
    </>
  )
}
