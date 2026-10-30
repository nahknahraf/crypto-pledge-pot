/**
 * Campaign page: progress, milestones (with vote tallies), a live donor feed
 * over SSE, and the Donate component. Donors can vote here; the creator sees
 * a link to their dashboard.
 */
import { useCallback, useEffect, useState } from 'react'
import type { CampaignDetail, CampaignEvent, PledgeView } from '../../../core/api'
import { AgentPanel } from '../components/AgentPanel'
import { DonateButton } from '../components/DonateButton'
import { Notice, Progress, StatusBadge } from '../components/ui'
import { dateTime, formatSats, formatUsd, short, timeLeft, useBsvPrice, WOC_TX } from '../format'
import { api, useWallet } from '../wallet'

export function Campaign ({ id }: { id: string }) {
  const { identityKey, bitfund, connect } = useWallet()
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
    const bf = bitfund ?? await connect()
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
