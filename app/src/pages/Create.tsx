/**
 * Launch a campaign: title, description, goal in BSV or USD (converted at
 * today's rate), deadline, refund date, and up to four milestones. One wallet
 * approval writes the campaign record on chain (OP_RETURN); the indexer then
 * lists it.
 *
 * Optional payment plan (NGOs): budget lines per milestone, the tolerance,
 * report and grace periods, an auditor for off-chain invoices and the legal
 * terms. The wallet signs the plan at launch (client/cryptoPledgePot.ts).
 */
import { useState, type FormEvent } from 'react'
import { P2PKH } from '@bsv/sdk'
import { MAX_MILESTONES } from '../../../core/pledge'
import type { Milestone } from '../../../core/campaign'
import { defaultLegalTerms, PLAN_DEFAULTS, PLAN_LIMITS, validatePaymentPlan, type PaymentPlan, type PlanLine } from '../../../core/paymentPlan'
import { Notice } from '../components/ui'
import { formatSats, SATS_PER_BSV, useBsvPrice } from '../format'
import { confirmSpend, useWallet } from '../wallet'

const toLocalInput = (d: Date): string => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
const fromLocalInput = (s: string): number => Math.floor(new Date(s).getTime() / 1000)

/** A budget line as typed in the form; the payee address becomes a locking script on launch. */
interface LineDraft { id: string, category: string, percent: number, payeeKind: 'onchain' | 'offchain', payeeName: string, address: string }

const newLine = (milestone: number, n: number, percent: number): LineDraft =>
  ({ id: `m${milestone}-line${n}`, category: '', percent, payeeKind: 'onchain', payeeName: '', address: '' })

/** Turn the form into a signed-plan candidate; throws with a readable message. */
function buildPlan (lines: LineDraft[][], milestoneCount: number, opts: { tolerance: number, reportDays: number, graceDays: number, auditorKey: string, legalTerms: string }): PaymentPlan {
  const milestones = lines.map((ls, i) => ({
    lines: ls.map((l): PlanLine => {
      const name = l.payeeName.trim()
      if (l.payeeKind === 'offchain') return { id: l.id.trim(), category: l.category.trim(), percent: l.percent, payee: { kind: 'offchain', name } }
      let lockingScript: string
      try { lockingScript = new P2PKH().lock(l.address.trim()).toHex() } catch {
        throw new Error(`milestone ${i + 1}, line "${l.id}": "${l.address}" is not a valid BSV address`)
      }
      return { id: l.id.trim(), category: l.category.trim(), percent: l.percent, payee: { kind: 'onchain', name, lockingScript } }
    })
  }))
  const auditorKey = opts.auditorKey.trim().toLowerCase()
  const plan: PaymentPlan = {
    v: 1,
    milestones,
    tolerancePercent: opts.tolerance,
    reportDays: opts.reportDays,
    graceDays: opts.graceDays,
    auditorKey: auditorKey === '' ? undefined : auditorKey,
    legalTerms: opts.legalTerms
  }
  validatePaymentPlan(plan, milestoneCount)
  return plan
}

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
  const [withPlan, setWithPlan] = useState(false)
  const [planLines, setPlanLines] = useState<LineDraft[][]>([[newLine(1, 1, 100)], [newLine(2, 1, 100)]])
  const [tolerance, setTolerance] = useState<number>(PLAN_DEFAULTS.tolerancePercent)
  const [reportDays, setReportDays] = useState<number>(PLAN_DEFAULTS.reportDays)
  const [graceDays, setGraceDays] = useState<number>(PLAN_DEFAULTS.graceDays)
  const [auditorKey, setAuditorKey] = useState('')
  const [customTerms, setCustomTerms] = useState<string>()
  const legalTerms = customTerms ?? defaultLegalTerms(tolerance, reportDays, graceDays)
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
  const addMilestone = () => {
    setMilestones(ms => [...ms, { title: '', percent: 0 }])
    setPlanLines(pl => [...pl, [newLine(pl.length + 1, 1, 100)]])
  }
  const removeMilestone = (i: number) => {
    setMilestones(ms => ms.filter((_, k) => k !== i))
    setPlanLines(pl => pl.filter((_, k) => k !== i))
  }
  const setLine = (i: number, j: number, patch: Partial<LineDraft>) =>
    setPlanLines(pl => pl.map((ls, k) => (k === i ? ls.map((l, n) => (n === j ? { ...l, ...patch } : l)) : ls)))
  const addLine = (i: number) => setPlanLines(pl => pl.map((ls, k) => (k === i ? [...ls, newLine(i + 1, ls.length + 1, 0)] : ls)))
  const removeLine = (i: number, j: number) => setPlanLines(pl => pl.map((ls, k) => (k === i ? ls.filter((_, n) => n !== j) : ls)))
  const needsAuditor = planLines.some(ls => ls.some(l => l.payeeKind === 'offchain'))

  async function submit (e: FormEvent) {
    e.preventDefault()
    setMsg(undefined)
    if (goalSats < 1) { setMsg({ ok: false, text: unit === 'USD' && price === undefined ? 'USD price unavailable, enter the goal in BSV.' : 'Enter a goal.' }); return }
    if (percentTotal !== 100) { setMsg({ ok: false, text: `Milestone shares must add up to 100% (now ${percentTotal}%).` }); return }
    let paymentPlan: PaymentPlan | undefined
    if (withPlan) {
      try {
        paymentPlan = buildPlan(planLines, milestones.length, { tolerance, reportDays, graceDays, auditorKey, legalTerms })
      } catch (err) {
        setMsg({ ok: false, text: `Payment plan: ${(err as Error).message.replace(/^invalid payment plan: /, '')}.` })
        return
      }
    }
    const bf = await connect()
    if (bf === undefined) return
    if (!confirmSpend(`Launch "${title}"?${paymentPlan !== undefined ? ' Your wallet also signs the payment plan, which becomes binding.' : ''} This writes the campaign record on chain (a fee of a few sats).`)) return
    setBusy(true)
    try {
      const { campaignId } = await bf.launch({
        title,
        description,
        imageUrl: imageUrl.trim() === '' ? undefined : imageUrl.trim(),
        goal: goalSats,
        deadline: fromLocalInput(deadline),
        refundAfter: fromLocalInput(refundAfter),
        milestones,
        paymentPlan
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
          {milestones.length > 1 && <button type="button" className="secondary" onClick={() => removeMilestone(i)}>✕</button>}
        </div>
      ))}
      <div className="row between">
        <button type="button" className="secondary" disabled={milestones.length >= MAX_MILESTONES} onClick={addMilestone}>Add milestone</button>
        <span className={percentTotal === 100 ? 'ok' : 'err'}>{percentTotal}% / 100%</span>
      </div>

      <h2>Payment plan <span className="muted small">(optional, for NGOs)</span></h2>
      <label className="row"><input type="checkbox" style={{ width: 'auto' }} checked={withPlan} onChange={e => setWithPlan(e.target.checked)} /> Commit to how every milestone will be spent</label>
      {withPlan && (
        <>
          <p className="muted small">Each milestone's money is split into budget lines (shares of what that milestone releases). After a release you pay each line and report it; deviations beyond the tolerance must be fixed or paid back to donors. Your wallet signs the plan, and it cannot change after the first pledge.</p>
          {milestones.map((m, i) => {
            const lines = planLines[i] ?? []
            const total = lines.reduce((s, l) => s + l.percent, 0)
            return (
              <div className="card" key={i}>
                <div className="row between"><strong>{i + 1}. {m.title === '' ? 'Milestone' : m.title}</strong><span className={total === 100 ? 'ok small' : 'err small'}>{total}% / 100%</span></div>
                {lines.map((l, j) => (
                  <div key={j} className="plan-line">
                    <div className="row milestone-row">
                      <input style={{ width: '9rem' }} required maxLength={32} placeholder="line id" value={l.id} onChange={e => setLine(i, j, { id: e.target.value.toLowerCase() })} />
                      <input className="grow" required maxLength={PLAN_LIMITS.category} placeholder="Category, e.g. Water filters" value={l.category} onChange={e => setLine(i, j, { category: e.target.value })} />
                      <input type="number" min={1} max={100} value={l.percent} onChange={e => setLine(i, j, { percent: Math.floor(Number(e.target.value)) })} />
                      <span>%</span>
                      {lines.length > 1 && <button type="button" className="secondary" onClick={() => removeLine(i, j)}>✕</button>}
                    </div>
                    <div className="row milestone-row">
                      <select style={{ width: '9rem' }} value={l.payeeKind} onChange={e => setLine(i, j, { payeeKind: e.target.value as LineDraft['payeeKind'] })}>
                        <option value="onchain">On chain</option>
                        <option value="offchain">Off chain</option>
                      </select>
                      <input className="grow" required maxLength={PLAN_LIMITS.payeeName} placeholder="Payee name" value={l.payeeName} onChange={e => setLine(i, j, { payeeName: e.target.value })} />
                      {l.payeeKind === 'onchain' && <input className="grow" required placeholder="Payee BSV address" value={l.address} onChange={e => setLine(i, j, { address: e.target.value })} />}
                    </div>
                  </div>
                ))}
                <button type="button" className="secondary" disabled={lines.length >= PLAN_LIMITS.linesPerMilestone} onClick={() => addLine(i)}>Add budget line</button>
              </div>
            )
          })}
          <div className="row">
            <label className="grow">Tolerance per line (%)<input type="number" min={0} max={25} value={tolerance} onChange={e => setTolerance(Math.floor(Number(e.target.value)))} /></label>
            <label className="grow">Days to spend and report<input type="number" min={1} max={365} value={reportDays} onChange={e => setReportDays(Math.floor(Number(e.target.value)))} /></label>
            <label className="grow">Grace days<input type="number" min={1} max={30} value={graceDays} onChange={e => setGraceDays(Math.floor(Number(e.target.value)))} /></label>
          </div>
          <label>Auditor identity key {needsAuditor ? '(required: some lines are paid off chain)' : '(optional)'}
            <input required={needsAuditor} pattern="0[23][0-9a-fA-F]{64}" placeholder="02… or 03… (66 hex characters)" value={auditorKey} onChange={e => setAuditorKey(e.target.value.trim())} />
          </label>
          <p className="muted small">The auditor signs each off-chain invoice; only signed invoices count as spending.</p>
          <label>Legal terms (signed by you, shown to donors)
            <textarea rows={8} maxLength={PLAN_LIMITS.legalTerms} value={legalTerms} onChange={e => setCustomTerms(e.target.value)} />
          </label>
          {customTerms !== undefined && <button type="button" className="secondary" onClick={() => setCustomTerms(undefined)}>Reset to the default terms</button>}
        </>
      )}

      <button type="submit" className="primary" disabled={busy}>{busy ? 'Approve in your wallet…' : 'Launch campaign'}</button>
      {walletError !== undefined && msg === undefined && <Notice kind="err">{walletError}</Notice>}
      {msg !== undefined && <Notice kind={msg.ok ? 'ok' : 'err'}>{msg.text}</Notice>}
    </form>
  )
}
