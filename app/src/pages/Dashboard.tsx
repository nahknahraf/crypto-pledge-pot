/**
 * Dashboard.
 *  Creator: per campaign, post milestone progress updates and withdraw
 *           (release) approved milestones into the wallet.
 *  Donor:   every pledge with its escrow state; reclaim it when the campaign
 *           failed (arbiter co-signed) or after the refund date (no one else needed).
 */
import { useCallback, useEffect, useState } from 'react'
import type { CampaignView, PledgeView } from '../../../core/api'
import { Notice, Progress, StatusBadge } from '../components/ui'
import { dateTime, formatSats, WOC_TX } from '../format'
import { api, confirmSpend, useWallet } from '../wallet'

type Msg = { ok: boolean, text: string, txid?: string }

export function Dashboard () {
  const { identityKey, connect, connecting, error } = useWallet()
  const [campaigns, setCampaigns] = useState<CampaignView[]>([])
  const [pledges, setPledges] = useState<Array<PledgeView & { campaignTitle: string }>>([])
  const [views, setViews] = useState<Record<string, CampaignView>>({})

  const load = useCallback(async () => {
    if (identityKey === undefined) return
    const all = await api.campaigns()
    setCampaigns(all.filter(c => c.meta.creatorIdentityKey === identityKey))
    setViews(Object.fromEntries(all.map(c => [c.id, c])))
    setPledges(await api.donorPledges(identityKey))
  }, [identityKey])

  useEffect(() => { void load() }, [load])

  if (identityKey === undefined) {
    return (
      <div className="card">
        <h1>Your dashboard</h1>
        <p>Connect your BRC-100 wallet (BSV Desktop) to manage your campaigns and pledges.</p>
        <button className="primary" disabled={connecting} onClick={() => { void connect() }}>{connecting ? 'Connecting…' : 'Connect wallet'}</button>
        {error !== undefined && <Notice kind="err">{error}</Notice>}
      </div>
    )
  }

  return (
    <>
      <h1>Your campaigns</h1>
      {campaigns.length === 0 && <p className="muted">You haven't launched a campaign yet. <a href="#/create">Start one</a></p>}
      {campaigns.map(c => <CreatorPanel key={c.id} c={c} onChange={() => { void load() }} />)}

      <h1>Your pledges</h1>
      {pledges.length === 0 && <p className="muted">No pledges yet.</p>}
      <div className="table">
        {pledges.map(p => <PledgeRow key={p.id} p={p} view={views[p.campaignId]} onChange={() => { void load() }} />)}
      </div>

      <RecoverPanel onChange={() => { void load() }} />
    </>
  )
}

/**
 * Recovery tools:
 *  - find pledges this wallet made that the index imported from chain, and claim them;
 *  - reclaim any escrow by its outpoint, without the server (after its refund date).
 */
function RecoverPanel ({ onChange }: { onChange: () => void }) {
  const { cryptopledgepot } = useWallet()
  const [outpoint, setOutpoint] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<Msg>()

  async function run (fn: () => Promise<Msg>) {
    setBusy(true); setMsg(undefined)
    try { setMsg(await fn()); onChange() } catch (e) { setMsg({ ok: false, text: (e as Error).message }) } finally { setBusy(false) }
  }

  return (
    <div className="card">
      <h2>Recover</h2>
      <p className="small muted">Pledges restored from the blockchain show up here once you claim them. Claiming proves, with your wallet, that you made them.</p>
      <button disabled={busy || cryptopledgepot === undefined} onClick={() => {
        void run(async () => {
          // Pledges broadcast while the server was unreachable first, then pledges restored from chain.
          const registered = await cryptopledgepot!.registerWalletPledges()
          const claimed = await cryptopledgepot!.claimWalletPledges()
          const found = registered.length + claimed.length
          return { ok: true, text: found === 0 ? 'Nothing to claim: all your pledges are already linked.' : `Linked ${found} pledge(s)${registered.length > 0 ? ` (${registered.length} registered from your wallet)` : ''}.` }
        })
      }}>Find my pledges</button>
      <p className="small muted" style={{ marginTop: '1rem' }}>Reclaim an escrow without CryptoPledgePot, e.g. one whose campaign no longer exists. Paste its outpoint (<code>txid.vout</code>). It works once the escrow's refund date has passed.</p>
      <div className="row">
        <input className="grow" placeholder="txid.vout" value={outpoint} onChange={e => setOutpoint(e.target.value.trim())} />
        <button disabled={busy || cryptopledgepot === undefined || !/^[0-9a-f]{64}\.\d+$/i.test(outpoint)} onClick={() => {
          if (!confirmSpend(`Reclaim the escrow ${outpoint.slice(0, 12)}… into your wallet?`)) return
          void run(async () => {
            const r = await cryptopledgepot!.reclaimEscrow(outpoint, { reportTo: api })
            return { ok: true, text: `Reclaimed ${formatSats(r.satoshis)}.`, txid: r.txid }
          })
        }}>Reclaim</button>
      </div>
      {msg !== undefined && <Notice kind={msg.ok ? 'ok' : 'err'}>{msg.text} {msg.txid !== undefined && <a href={WOC_TX + msg.txid} target="_blank" rel="noreferrer">View</a>}</Notice>}
    </div>
  )
}

function CreatorPanel ({ c, onChange }: { c: CampaignView, onChange: () => void }) {
  const { cryptopledgepot } = useWallet()
  const next = c.milestones.find(m => !m.released)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<Msg>()

  async function act (fn: () => Promise<Msg>) {
    setBusy(true)
    setMsg(undefined)
    try { setMsg(await fn()); onChange() } catch (e) { setMsg({ ok: false, text: (e as Error).message }) } finally { setBusy(false) }
  }

  return (
    <div className="card">
      <div className="row between"><a href={`#/c/${c.id}`}><h2>{c.meta.title}</h2></a><StatusBadge status={c.status} /></div>
      <Progress value={c.raised} goal={c.meta.goal} />
      <p className="small">{formatSats(c.raised)} raised of {formatSats(c.meta.goal)} · {formatSats(c.released)} withdrawn · {formatSats(c.escrowed)} in escrow · deadline {dateTime(c.meta.deadline)}</p>
      {next === undefined && <Notice kind="ok">All milestones released. 🎉</Notice>}
      {next !== undefined && (
        <div className="milestone-action">
          <p><strong>Next: milestone {next.index}, {next.title}</strong> ({next.percent}%)</p>
          {next.approved
            ? (
              <button className="primary" disabled={busy || cryptopledgepot === undefined} onClick={() => {
                if (!confirmSpend(`Withdraw milestone ${next.index} of "${c.meta.title}" into your wallet?`)) return
                void act(async () => {
                  const r = await cryptopledgepot!.release(c.id)
                  return { ok: true, text: `Released ${formatSats(r.released)} for milestone ${r.milestone} into your wallet (minus network fee).`, txid: r.txids[0] }
                })
              }}>{busy ? 'Approve in your wallet…' : `Withdraw milestone ${next.index}`}</button>)
            : <p className="muted small">{next.pending}</p>}
          {next.index > 1 && c.status === 'funded' && (
            <div>
              <label>Progress update for donors{next.update !== undefined && ' (replaces the current one)'}
                <textarea rows={3} value={note} onChange={e => setNote(e.target.value)} placeholder="What did you deliver? Links to evidence help donors vote." />
              </label>
              <button disabled={busy || note.trim() === ''} onClick={() => {
                void act(async () => { await cryptopledgepot!.postUpdate(c.id, next.index, note); setNote(''); return { ok: true, text: 'Update posted. Donors can vote now.' } })
              }}>Post update and open the vote</button>
            </div>
          )}
        </div>
      )}
      {msg !== undefined && <Notice kind={msg.ok ? 'ok' : 'err'}>{msg.text} {msg.txid !== undefined && <a href={WOC_TX + msg.txid} target="_blank" rel="noreferrer">View transaction</a>}</Notice>}
    </div>
  )
}

function PledgeRow ({ p, view, onChange }: { p: PledgeView & { campaignTitle: string }, view?: CampaignView, onChange: () => void }) {
  const { cryptopledgepot } = useWallet()
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<Msg>()
  const now = Date.now() / 1000
  const canSelfRefund = view !== undefined && now >= view.meta.refundAfter
  const canRefund = p.status === 'active' && view !== undefined && (view.status === 'failed' || canSelfRefund)

  async function refund () {
    if (!confirmSpend(`Reclaim ${formatSats(p.escrowed)} from your pledge to "${p.campaignTitle}"?`)) return
    setBusy(true)
    setMsg(undefined)
    try {
      const r = await cryptopledgepot!.refund(p.id, canSelfRefund ? 'deadline' : 'failed')
      setMsg({ ok: true, text: `Reclaimed ${formatSats(r.satoshis)}.`, txid: r.txid })
      onChange()
    } catch (e) { setMsg({ ok: false, text: (e as Error).message }) } finally { setBusy(false) }
  }

  return (
    <div className="pledge-row">
      <div>
        <a href={`#/c/${p.campaignId}`}>{p.campaignTitle}</a>
        <p className="muted small">{dateTime(p.createdAt)} · {p.stage} milestone(s) released · {p.status}</p>
      </div>
      <div className="right">
        <strong>{formatSats(p.amount)}</strong>
        <p className="muted small">{formatSats(p.escrowed)} still in escrow</p>
      </div>
      <div>
        {canRefund && <button disabled={busy} onClick={() => { void refund() }}>{busy ? 'Approve…' : canSelfRefund ? 'Reclaim (refund date passed)' : 'Reclaim (campaign failed)'}</button>}
        {p.status === 'active' && !canRefund && view !== undefined && <span className="muted small">self-refund from {new Date(view.meta.refundAfter * 1000).toLocaleDateString()}</span>}
      </div>
      {msg !== undefined && <Notice kind={msg.ok ? 'ok' : 'err'}>{msg.text} {msg.txid !== undefined && <a href={WOC_TX + msg.txid} target="_blank" rel="noreferrer">View</a>}</Notice>}
    </div>
  )
}
