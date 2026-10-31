/**
 * Campaign page: progress, milestones (with vote tallies), a live donor feed
 * over SSE, and the Donate component. Donors can vote here; the creator sees
 * a link to their dashboard.
 *
 * Campaigns with a payment plan also show the plan, its legal terms and, per
 * released milestone, the compliance state. The creator pays on-chain budget
 * lines, reports auditor-signed invoices and repays donors from here.
 */
import { useCallback, useEffect, useState } from 'react'
import type { CampaignDetail, CampaignEvent, MilestoneView, PledgeView } from '../../../core/api'
import type { ComplianceState } from '../../../core/compliance'
import type { CryptoPledgePot } from '../../../client/cryptoPledgePot'
import { AgentPanel } from '../components/AgentPanel'
import { DonateButton } from '../components/DonateButton'
import { Notice, Progress, StatusBadge } from '../components/ui'
import { dateTime, formatSats, formatUsd, short, timeLeft, useBsvPrice, WOC_TX } from '../format'
import { api, confirmSpend, useWallet } from '../wallet'

export function Campaign ({ id }: { id: string }) {
  const { identityKey, cryptopledgepot, connect } = useWallet()
  const price = useBsvPrice()
  const [c, setC] = useState<CampaignDetail>()
  const [error, setError] = useState<string>()
  const [flash, setFlash] = useState<string>()
  const [voteMsg, setVoteMsg] = useState<{ ok: boolean, text: string }>()

  const load = useCallback(() => { api.campaign(id).then(setC, e => setError((e as Error).message)) }, [id])

  useEffect(() => {
    load()
    const es = new EventSource(api.eventsUrl(id))
    es.onmessage = (m) => {
      const ev = JSON.parse(m.data) as CampaignEvent
      if (ev.type === 'pledge') setFlash(`New pledge: ${formatSats(ev.pledge.amount)}${ev.pledge.name !== null ? ` from ${ev.pledge.name}` : ''}`)
      if (ev.type === 'release') setFlash(`Milestone ${ev.milestone} released: ${formatSats(ev.amount)}`)
      load()
    }
    return () => es.close()
  }, [id, load])

  if (error !== undefined) return <Notice kind="err">{error}</Notice>
  if (c === undefined) return <p className="muted">Loading…</p>

  const isCreator = identityKey === c.meta.creatorIdentityKey
  const myPledges = c.feed.filter(p => p.donorIdentity === identityKey && p.status !== 'refunded')

  async function vote (milestone: number, approve: boolean) {
    const bf = cryptopledgepot ?? await connect()
    if (bf === undefined) return
    try {
      await bf.vote(id, milestone, approve)
      setVoteMsg({ ok: true, text: `Vote recorded: ${approve ? 'approve' : 'reject'} milestone ${milestone}.` })
      load()
    } catch (e) { setVoteMsg({ ok: false, text: (e as Error).message }) }
  }

  return (
    <div className="campaign">
      <div className="main">
        {c.meta.imageUrl !== undefined && <img className="cover" src={c.meta.imageUrl} alt="" />}
        <div className="row between"><span className="row"><StatusBadge status={c.status} />{c.meta.kind === 'agent' && <span className="badge agent">AI agent</span>}</span><span className="muted small">{c.status === 'active' ? timeLeft(c.meta.deadline) : `deadline ${dateTime(c.meta.deadline)}`}</span></div>
        <h1>{c.meta.title}</h1>
        <p className="muted small">
          by <code title={c.meta.creatorIdentityKey}>{short(c.meta.creatorIdentityKey)}</code> · anchored on chain in{' '}
          <a href={WOC_TX + c.anchorTxid} target="_blank" rel="noreferrer">{short(c.anchorTxid)}</a>
          {isCreator && <> · <a href="#/dashboard">manage in your dashboard</a></>}
        </p>
        <p className="description">{c.meta.description}</p>

        <h2>Milestones</h2>
        <ol className="milestones">
          {c.milestones.map(m => (
            <li key={m.index} className={m.released ? 'released' : m.approved ? 'approved' : ''}>
              <div className="row between">
                <strong>{m.index}. {m.title}</strong>
                <span className="muted">{m.percent}% · {formatSats(Math.floor(c.raised * m.percent / 100))}</span>
              </div>
              {m.released && <p className="ok small">Released {m.releaseTxids.map(t => <a key={t} href={WOC_TX + t} target="_blank" rel="noreferrer"> {short(t)}</a>)}</p>}
              {!m.released && m.pending !== undefined && <p className="muted small">{m.pending}</p>}
              {!m.released && m.approved && <p className="ok small">Approved: the creator can release it now.</p>}
              {m.compliance !== undefined && <Compliance c={c} m={m} isCreator={isCreator} getClient={async () => cryptopledgepot ?? await connect()} onChange={load} />}
              {m.update !== undefined && <blockquote>{m.update.note}<span className="muted small"> · {dateTime(m.update.createdAt)}</span></blockquote>}
              {m.index > 1 && !m.released && m.update !== undefined && (
                <div className="votes">
                  <div className="vote-bar"><div className="yes" style={{ width: `${c.raised > 0 ? (m.votes.yes / c.raised) * 100 : 0}%` }} /><div className="no" style={{ width: `${c.raised > 0 ? (m.votes.no / c.raised) * 100 : 0}%` }} /></div>
                  <p className="small muted">YES {formatSats(m.votes.yes)} · NO {formatSats(m.votes.no)} · needs more than {formatSats(Math.floor(c.raised / 2))}</p>
                  {myPledges.length > 0 && (
                    <div className="row">
                      <button onClick={() => { void vote(m.index, true) }}>Approve</button>
                      <button className="secondary" onClick={() => { void vote(m.index, false) }}>Reject</button>
                    </div>
                  )}
                </div>
              )}
            </li>
          ))}
        </ol>
        {voteMsg !== undefined && <Notice kind={voteMsg.ok ? 'ok' : 'err'}>{voteMsg.text}</Notice>}
        {c.meta.paymentPlan !== undefined && <PlanSection c={c} />}
      </div>

      <aside className="side">
        <div className="card">
          <div className="big">{formatSats(c.raised)}</div>
          <p className="muted">raised of {formatSats(c.meta.goal)} {formatUsd(c.meta.goal, price) !== undefined && `(${formatUsd(c.meta.goal, price)})`}</p>
          <Progress value={c.raised} goal={c.meta.goal} />
          <div className="stats">
            <div><strong>{c.donors}</strong><span>donors</span></div>
            <div><strong>{formatSats(c.escrowed)}</strong><span>in escrow</span></div>
            <div><strong>{formatSats(c.released)}</strong><span>released</span></div>
          </div>
          {c.status === 'active'
            ? <DonateButton meta={c.meta} onDonated={load} />
            : c.status === 'funded'
              ? <Notice kind="ok">Goal reached: this campaign is fully funded and no longer takes pledges.</Notice>
              : <Notice kind="info">This campaign is no longer accepting pledges.</Notice>}
          {myPledges.length > 0 && <p className="small">You have {myPledges.length} pledge(s) here. <a href="#/dashboard">Manage or refund</a></p>}
        </div>

        {c.meta.kind === 'agent' && c.meta.agentUrl !== undefined && <AgentPanel agentUrl={c.meta.agentUrl} />}

        <div className="card feed">
          <h3>Live donor feed {flash !== undefined && <span className="flash">{flash}</span>}</h3>
          {c.feed.length === 0 && <p className="muted">Be the first to back this.</p>}
          <ul>{c.feed.map(p => <FeedItem key={p.id} p={p} />)}</ul>
        </div>
      </aside>
    </div>
  )
}

function FeedItem ({ p }: { p: PledgeView }) {
  return (
    <li className={p.status}>
      <div className="row between">
        <strong>{p.name ?? 'Anonymous'}</strong>
        <span>{formatSats(p.amount)}</span>
      </div>
      {p.message !== null && <p>{p.message}</p>}
      <p className="muted small">
        {dateTime(p.createdAt)} · <a href={WOC_TX + p.id.split('.')[0]} target="_blank" rel="noreferrer">{short(p.id.split('.')[0])}</a>
        {p.status === 'refunded' && ' · refunded'}
      </p>
    </li>
  )
}

const STATE_LABEL: Record<ComplianceState, string> = { reporting: 'Reporting', compliant: 'Compliant', grace: 'Grace period', cured: 'Cured', repaid: 'Repaid', breached: 'Breached' }
const STATE_CLASS: Record<ComplianceState, string> = { reporting: 'completed', compliant: '', grace: 'funded', cured: '', repaid: '', breached: 'breached' }
const dateOnly = (unix: number): string => new Date(unix * 1000).toLocaleDateString()

/** The signed payment plan: budget lines per milestone, the rules and the legal terms. */
function PlanSection ({ c }: { c: CampaignDetail }) {
  const plan = c.meta.paymentPlan!
  return (
    <>
      <h2>Payment plan</h2>
      <p className="muted small">
        Signed by the creator before the first pledge. Each budget line may deviate by at most {plan.tolerancePercent}%; every line must be reported within {plan.reportDays} days of a release, with {plan.graceDays} more days to fix a gap or pay it back.
        {plan.auditorKey !== undefined && <> Off-chain invoices count when signed by the auditor <code title={plan.auditorKey}>{short(plan.auditorKey)}</code>.</>}
      </p>
      {plan.milestones.map((mp, i) => (
        <div className="card" key={i}>
          <strong>{i + 1}. {c.milestones[i]?.title}</strong>
          <table className="plan-table">
            <thead><tr><th>Line</th><th>Category</th><th>Payee</th><th className="right">Share</th></tr></thead>
            <tbody>
              {mp.lines.map(l => (
                <tr key={l.id}>
                  <td><code>{l.id}</code></td>
                  <td>{l.category}{l.description !== undefined && <span className="muted small"> · {l.description}</span>}</td>
                  <td>{l.payee.name} <span className="muted small">{l.payee.kind === 'onchain' ? 'on chain' : 'off chain'}</span></td>
                  <td className="right">{l.percent}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
      <h3>Legal terms</h3>
      <blockquote>{plan.legalTerms}</blockquote>
    </>
  )
}

type Msg = { ok: boolean, text: string, txid?: string }
const isHex = (s: string, bytes?: number): boolean => (bytes === undefined ? /^([0-9a-f]{2})+$/ : new RegExp(`^[0-9a-f]{${bytes * 2}}$`)).test(s)

/** One released milestone measured against the plan, with the creator's actions. */
function Compliance ({ c, m, isCreator, getClient, onChange }: { c: CampaignDetail, m: MilestoneView, isCreator: boolean, getClient: () => Promise<CryptoPledgePot | undefined>, onChange: () => void }) {
  const comp = m.compliance!
  const plan = c.meta.paymentPlan!
  const lines = plan.milestones[m.index - 1]?.lines ?? []
  const open = comp.state === 'reporting' || comp.state === 'grace'
  const offchain = lines.filter(l => l.payee.kind === 'offchain')
  const [amounts, setAmounts] = useState<Record<string, string>>({})
  const [invoice, setInvoice] = useState({ lineId: offchain[0]?.id ?? '', sats: '', sha256: '', attestation: '', note: '' })
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<Msg>()

  async function act (fn: (bf: CryptoPledgePot) => Promise<Msg>) {
    const bf = await getClient()
    if (bf === undefined) return
    setBusy(true); setMsg(undefined)
    try { setMsg(await fn(bf)); onChange() } catch (e) { setMsg({ ok: false, text: (e as Error).message }) } finally { setBusy(false) }
  }

  function payLine (lineId: string, payee: string, sats: number) {
    if (!Number.isSafeInteger(sats) || sats < 1) { setMsg({ ok: false, text: 'Enter a whole number of sats to pay.' }); return }
    if (!confirmSpend(`Pay ${formatSats(sats)} to ${payee} for budget line "${lineId}" (milestone ${m.index})?`)) return
    void act(async bf => {
      const r = await bf.payPlanLine(c.id, m.index, lineId, sats)
      return { ok: true, text: `Paid ${formatSats(sats)} to ${payee} and reported it.`, txid: r.txid }
    })
  }

  function reportInvoice () {
    const sats = Number(invoice.sats)
    const sha256 = invoice.sha256.trim().toLowerCase()
    const attestation = invoice.attestation.trim().toLowerCase()
    if (!Number.isSafeInteger(sats) || sats < 1) { setMsg({ ok: false, text: 'Enter the invoice amount in whole sats.' }); return }
    if (!isHex(sha256, 32)) { setMsg({ ok: false, text: 'The invoice sha256 must be 64 hex characters.' }); return }
    if (!isHex(attestation)) { setMsg({ ok: false, text: 'The auditor signature must be hex.' }); return }
    void act(async bf => {
      const note = invoice.note.trim()
      await bf.reportSpending(c.id, m.index, [{ lineId: invoice.lineId, sats, invoiceSha256: sha256, attestation, note: note === '' ? undefined : note }])
      setInvoice(v => ({ ...v, sats: '', sha256: '', attestation: '', note: '' }))
      return { ok: true, text: `Invoice reported for line "${invoice.lineId}".` }
    })
  }

  const owed = comp.dueBackSats - comp.repaidSats

  return (
    <div className="compliance">
      <div className="row between">
        <span className="row"><span className={`badge ${STATE_CLASS[comp.state]}`}>{STATE_LABEL[comp.state]}</span><span className="small">{comp.detail}</span></span>
      </div>
      <p className="muted small">Released {dateOnly(comp.releasedAt)} · report due {dateOnly(comp.reportDueAt)} · grace ends {dateOnly(comp.graceEndsAt)}</p>
      <table className="plan-table">
        <thead><tr><th>Line</th><th>Payee</th><th className="right">Planned</th><th className="right">Spent</th><th className="right">Deviation</th>{isCreator && open && <th />}</tr></thead>
        <tbody>
          {comp.spending.lines.map(r => {
            const line = lines.find(l => l.id === r.lineId)
            const rest = Math.max(0, r.plannedSats - r.spentSats)
            return (
              <tr key={r.lineId}>
                <td>{r.category} <code className="muted small">{r.lineId}</code></td>
                <td>{r.payee}</td>
                <td className="right">{formatSats(r.plannedSats)}</td>
                <td className="right">{formatSats(r.spentSats)}</td>
                <td className={`right ${r.withinTolerance ? 'ok' : 'err'}`}>{r.deviationPercent}%</td>
                {isCreator && open && (
                  <td>
                    {line?.payee.kind === 'onchain' && (
                      <span className="row">
                        <input style={{ width: '7rem', margin: 0 }} inputMode="numeric" placeholder="sats" value={amounts[r.lineId] ?? String(rest)} onChange={e => setAmounts(a => ({ ...a, [r.lineId]: e.target.value.trim() }))} />
                        <button disabled={busy} onClick={() => payLine(r.lineId, r.payee, Number(amounts[r.lineId] ?? rest))}>Pay line</button>
                      </span>
                    )}
                    {line?.payee.kind === 'offchain' && <span className="muted small">invoice below</span>}
                  </td>
                )}
              </tr>
            )
          })}
        </tbody>
      </table>
      <p className="small">
        Released {formatSats(comp.spending.releasedSats)} · counted spending {formatSats(comp.spending.compliantSats)}
        {comp.dueBackSats > 0 && <> · <span className="err">due back {formatSats(comp.dueBackSats)}</span></>}
        {comp.repaidSats > 0 && <> · repaid {formatSats(comp.repaidSats)}</>}
      </p>

      {isCreator && open && offchain.length > 0 && (
        <details>
          <summary className="small">Report an off-chain invoice</summary>
          <div className="row">
            <label>Line
              <select value={invoice.lineId} onChange={e => setInvoice(v => ({ ...v, lineId: e.target.value }))}>
                {offchain.map(l => <option key={l.id} value={l.id}>{l.id} · {l.payee.name}</option>)}
              </select>
            </label>
            <label className="grow">Amount (sats)<input inputMode="numeric" value={invoice.sats} onChange={e => setInvoice(v => ({ ...v, sats: e.target.value.trim() }))} /></label>
          </div>
          <label>Invoice sha256 (hex)<input value={invoice.sha256} onChange={e => setInvoice(v => ({ ...v, sha256: e.target.value }))} placeholder="64 hex characters" /></label>
          <label>Auditor signature (hex)<input value={invoice.attestation} onChange={e => setInvoice(v => ({ ...v, attestation: e.target.value }))} /></label>
          <label>Note (optional)<input maxLength={280} value={invoice.note} onChange={e => setInvoice(v => ({ ...v, note: e.target.value }))} /></label>
          <button disabled={busy} onClick={reportInvoice}>Report invoice</button>
        </details>
      )}

      {isCreator && comp.state === 'grace' && owed > 0 && (
        <button className="primary" disabled={busy} onClick={() => {
          if (!confirmSpend(`Pay ${formatSats(owed)} back to the donors of milestone ${m.index}, pro rata?`)) return
          void act(async bf => {
            const r = await bf.repay(c.id, m.index)
            return { ok: true, text: `Repaid ${formatSats(r.sats)} to the donors.`, txid: r.txid }
          })
        }}>{busy ? 'Approve in your wallet…' : `Repay donors (${formatSats(owed)})`}</button>
      )}
      {msg !== undefined && <Notice kind={msg.ok ? 'ok' : 'err'}>{msg.text} {msg.txid !== undefined && <a href={WOC_TX + msg.txid} target="_blank" rel="noreferrer">View transaction</a>}</Notice>}
    </div>
  )
}
