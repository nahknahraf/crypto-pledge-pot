import type { ReactNode } from 'react'
import type { CampaignView } from '../../../core/api'
import type { CampaignStatus } from '../../../core/campaign'
import { formatSats, formatUsd, timeLeft, useBsvPrice } from '../format'

export function Progress ({ value, goal }: { value: number, goal: number }) {
  const pct = goal > 0 ? Math.min(100, (value / goal) * 100) : 0
  return (
    <div className="progress" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
      <div className="bar" style={{ width: `${pct}%` }} />
    </div>
  )
}

const LABEL: Record<CampaignStatus, string> = { active: 'Raising', funded: 'Funded', failed: 'Missed goal', completed: 'Completed', breached: 'Broke its plan' }

export const StatusBadge = ({ status }: { status: CampaignStatus }) => <span className={`badge ${status}`}>{LABEL[status]}</span>

export function CampaignCard ({ c }: { c: CampaignView }) {
  const price = useBsvPrice()
  const pct = Math.floor((c.raised / c.meta.goal) * 100)
  return (
    <a className="card campaign-card" href={`#/c/${c.id}`}>
      {c.meta.imageUrl !== undefined && <img src={c.meta.imageUrl} alt="" loading="lazy" />}
      <div className="row between"><span className="row"><StatusBadge status={c.status} />{c.meta.kind === 'agent' && <span className="badge agent">AI agent</span>}</span><span className="muted small">{c.status === 'active' ? timeLeft(c.meta.deadline) : `${c.milestonesReleased}/${c.meta.milestones.length} milestones`}</span></div>
      <h3>{c.meta.title}</h3>
      <p className="muted clamp">{c.meta.description}</p>
      <Progress value={c.raised} goal={c.meta.goal} />
      <div className="row between small">
        <strong>{formatSats(c.raised)}</strong>
        <span className="muted">{pct}% of {formatSats(c.meta.goal)}{formatUsd(c.meta.goal, price) !== undefined ? ` (${formatUsd(c.meta.goal, price)})` : ''}</span>
      </div>
      <p className="muted small">{c.donors} donor{c.donors === 1 ? '' : 's'}</p>
    </a>
  )
}

export function Notice ({ kind, children }: { kind: 'ok' | 'err' | 'info', children: ReactNode }) {
  return <p className={`notice ${kind}`}>{children}</p>
}
