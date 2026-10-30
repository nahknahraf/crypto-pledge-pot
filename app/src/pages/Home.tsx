import { useEffect, useState } from 'react'
import type { CampaignView } from '../../../core/api'
import type { CampaignStatus } from '../../../core/campaign'
import { CampaignCard, Notice } from '../components/ui'
import { formatSats } from '../format'
import { api } from '../wallet'

const TABS: Array<{ key: CampaignStatus | 'all', label: string }> = [
  { key: 'active', label: 'Active' },
  { key: 'funded', label: 'Funded' },
  { key: 'completed', label: 'Completed' },
  { key: 'failed', label: 'Missed goal' },
  { key: 'all', label: 'All' }
]

export function Home () {
  const [campaigns, setCampaigns] = useState<CampaignView[]>()
  const [error, setError] = useState<string>()
  const [tab, setTab] = useState<CampaignStatus | 'all'>('active')

  useEffect(() => {
    const load = () => { api.campaigns().then(setCampaigns, e => setError((e as Error).message)) }
    load()
    const t = setInterval(load, 10_000)
    return () => clearInterval(t)
  }, [])

  const shown = (campaigns ?? []).filter(c => tab === 'all' || c.status === tab)
  const total = (campaigns ?? []).reduce((s, c) => s + c.raised, 0)

  return (
    <>
      <section className="hero">
        <h1>Fund ideas without paying the middleman.</h1>
        <p>
          On BitFund, donations go straight into on-chain escrow contracts. Creators get funds milestone by milestone as donors approve.
          If a campaign fails, donors take their sats back without asking anyone. Fees are a fraction of a cent, so tiny donations work too.
        </p>
        <div className="row">
          <a className="button primary" href="#/create">Start a campaign</a>
          {campaigns !== undefined && <span className="muted">{campaigns.length} campaigns · {formatSats(total)} pledged</span>}
        </div>
      </section>

      <nav className="tabs">
        {TABS.map(t => (
          <button key={t.key} className={tab === t.key ? 'tab active' : 'tab'} onClick={() => setTab(t.key)}>
            {t.label} {campaigns !== undefined && <span className="muted">({campaigns.filter(c => t.key === 'all' || c.status === t.key).length})</span>}
          </button>
        ))}
      </nav>

      {error !== undefined && <Notice kind="err">Indexer unreachable: {error}. Is <code>npm run server</code> running?</Notice>}
      {campaigns === undefined && error === undefined && <p className="muted">Loading campaigns…</p>}
      {campaigns !== undefined && shown.length === 0 && <p className="muted">Nothing here yet.</p>}
      <div className="grid">{shown.map(c => <CampaignCard key={c.id} c={c} />)}</div>
    </>
  )
}
