/**
 * Launch a campaign: title, description, goal in BSV or USD (converted at
 * today's rate), deadline, refund date, and up to four milestones. One wallet
 * approval writes the campaign record on chain (OP_RETURN); the indexer then
 * lists it.
 */
import { useState, type FormEvent } from 'react'
import { MAX_MILESTONES } from '../../../core/pledge'
import type { Milestone } from '../../../core/campaign'
import { Notice } from '../components/ui'
import { formatSats, SATS_PER_BSV, useBsvPrice } from '../format'
import { confirmSpend, useWallet } from '../wallet'

const toLocalInput = (d: Date): string => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
const fromLocalInput = (s: string): number => Math.floor(new Date(s).getTime() / 1000)

export function Create () {
  const { connect, error: walletError } = useWallet()
  const price = useBsvPrice()
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [imageUrl, setImageUrl] = useState('')
  const [goalText, setGoalText] = useState('0.01')
  const [unit, setUnit] = useState<'BSV' | 'USD'>('BSV')
  const [deadline, setDeadline] = useState(toLocalInput(new Date(Date.now() + 14 * 86_400_000)))
  const [refundAfter, setRefundAfter] = useState(toLocalInput(new Date(Date.now() + 74 * 86_400_000)))
  const [milestones, setMilestones] = useState<Milestone[]>([{ title: 'Kick-off', percent: 30 }, { title: 'Deliver', percent: 70 }])
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean, text: string }>()

  const goalSats = (() => {
    const n = Number(goalText)
    if (!Number.isFinite(n) || n <= 0) return 0
    if (unit === 'BSV') return Math.round(n * SATS_PER_BSV)
    return price === undefined ? 0 : Math.round((n / price) * SATS_PER_BSV)
  })()
  const percentTotal = milestones.reduce((s, m) => s + m.percent, 0)

  const setMilestone = (i: number, patch: Partial<Milestone>) => setMilestones(ms => ms.map((m, k) => (k === i ? { ...m, ...patch } : m)))

  async function submit (e: FormEvent) {
    e.preventDefault()
    setMsg(undefined)
    if (goalSats < 1) { setMsg({ ok: false, text: unit === 'USD' && price === undefined ? 'USD price unavailable, enter the goal in BSV.' : 'Enter a goal.' }); return }
    if (percentTotal !== 100) { setMsg({ ok: false, text: `Milestone shares must add up to 100% (now ${percentTotal}%).` }); return }
    const bf = await connect()
    if (bf === undefined) return
    if (!confirmSpend(`Launch "${title}"? This writes the campaign record on chain (a fee of a few sats).`)) return
    setBusy(true)
    try {
      const { campaignId } = await bf.launch({
        title,
        description,
        imageUrl: imageUrl.trim() === '' ? undefined : imageUrl.trim(),
        goal: goalSats,
        deadline: fromLocalInput(deadline),
        refundAfter: fromLocalInput(refundAfter),
        milestones
      })
      window.location.hash = `#/c/${campaignId}`
    } catch (err) {
      setMsg({ ok: false, text: (err as Error).message })
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="card form" onSubmit={e => { void submit(e) }}>
      <h1>Start a campaign</h1>
      <label>Title<input required maxLength={80} value={title} onChange={e => setTitle(e.target.value)} /></label>
      <label>Story<textarea rows={6} maxLength={4000} value={description} onChange={e => setDescription(e.target.value)} /></label>
      <label>Cover image URL (https, optional)<input type="url" pattern="https://.*" value={imageUrl} onChange={e => setImageUrl(e.target.value)} /></label>

      <div className="row">
        <label className="grow">Goal
          <input required inputMode="decimal" value={goalText} onChange={e => setGoalText(e.target.value)} />
        </label>
        <label>Unit
          <select value={unit} onChange={e => setUnit(e.target.value as 'BSV' | 'USD')}>
            <option>BSV</option>
            <option disabled={price === undefined}>USD</option>
          </select>
        </label>
      </div>
      <p className="muted small">= {formatSats(goalSats)}{price !== undefined && ` · 1 BSV ≈ $${price.toFixed(2)}`}. All or nothing: if the goal isn't reached by the deadline, donors are refunded.</p>

      <div className="row">
        <label className="grow">Deadline<input type="datetime-local" required value={deadline} onChange={e => setDeadline(e.target.value)} /></label>
        <label className="grow">Donors may self-refund after<input type="datetime-local" required value={refundAfter} onChange={e => setRefundAfter(e.target.value)} /></label>
      </div>
      <p className="muted small">After the refund date, donors can reclaim whatever hasn't been released, using only their own wallet. Leave enough time to deliver every milestone.</p>

      <h2>Milestones</h2>
      <p className="muted small">Milestone 1 is released once the goal is met. Each later one needs your progress update and a YES vote from donors holding more than half of the pledged sats.</p>
      {milestones.map((m, i) => (
        <div className="row milestone-row" key={i}>
          <span className="muted">{i + 1}.</span>
          <input className="grow" required maxLength={80} placeholder="What will you deliver?" value={m.title} onChange={e => setMilestone(i, { title: e.target.value })} />
          <input type="number" min={1} max={100} value={m.percent} onChange={e => setMilestone(i, { percent: Math.floor(Number(e.target.value)) })} />
          <span>%</span>
          {milestones.length > 1 && <button type="button" className="secondary" onClick={() => setMilestones(ms => ms.filter((_, k) => k !== i))}>✕</button>}
        </div>
      ))}
      <div className="row between">
        <button type="button" className="secondary" disabled={milestones.length >= MAX_MILESTONES} onClick={() => setMilestones(ms => [...ms, { title: '', percent: 0 }])}>Add milestone</button>
        <span className={percentTotal === 100 ? 'ok' : 'err'}>{percentTotal}% / 100%</span>
      </div>

      <button type="submit" className="primary" disabled={busy}>{busy ? 'Approve in your wallet…' : 'Launch campaign'}</button>
      {walletError !== undefined && msg === undefined && <Notice kind="err">{walletError}</Notice>}
      {msg !== undefined && <Notice kind={msg.ok ? 'ok' : 'err'}>{msg.text}</Notice>}
    </form>
  )
}
