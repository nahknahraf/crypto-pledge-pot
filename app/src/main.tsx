import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Campaign } from './pages/Campaign'
import { Create } from './pages/Create'
import { Dashboard } from './pages/Dashboard'
import { Donor } from './pages/Donor'
import { Home } from './pages/Home'
import { short } from './format'
import { useWallet, WalletProvider } from './wallet'
import './style.css'

function useHashRoute (): string {
  const [hash, setHash] = useState(window.location.hash)
  useEffect(() => {
    const on = () => { setHash(window.location.hash); window.scrollTo(0, 0) }
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  return hash.replace(/^#/, '') || '/'
}

function Header () {
  const { identityKey, network, connect, connecting, serverNetwork } = useWallet()
  return (
    <header className="top">
      <a className="logo" href="#/">Crypto<span>PledgePot</span></a>
      <nav>
        <a href="#/">Campaigns</a>
        <a href="#/create">Start a campaign</a>
        <a href="#/dashboard">Dashboard</a>
        <a href="#/donor">My donor agent</a>
      </nav>
      {identityKey !== undefined
        ? <span className="chip" title={identityKey}>● {network === 'testnet' ? 'testnet · ' : ''}{short(identityKey)}</span>
        : <button className="primary" disabled={connecting || serverNetwork === 'mock'} title={serverNetwork === 'mock' ? 'Disabled in the offline demo' : undefined} onClick={() => { void connect() }}>{connecting ? 'Connecting…' : 'Connect wallet'}</button>}
    </header>
  )
}

interface DemoStory { title: string, step: number, total: number, text: string, done: boolean, error?: string, campaignId?: string }

function DemoBanner () {
  const { serverNetwork } = useWallet()
  const [story, setStory] = useState<DemoStory>()
  useEffect(() => {
    if (serverNetwork !== 'mock') return
    const poll = (): void => { fetch('/api/demo').then(async r => (r.ok ? await r.json() : undefined)).then(setStory, () => setStory(undefined)) }
    poll()
    const t = setInterval(poll, 2_000)
    return () => clearInterval(t)
  }, [serverNetwork])
  if (serverNetwork !== 'mock') return null
  return (
    <div className="demo-banner">
      {story !== undefined && (
        <div className="story">
          <strong>{story.title} · step {story.step}/{story.total}{story.done ? ' · complete' : ''}</strong>
          <span>{story.error !== undefined ? `Stopped: ${story.error}` : story.text}</span>
          {story.campaignId !== undefined && <a href={`#/c/${story.campaignId}`}>Watch the campaign →</a>}
          <div className="story-bar"><div style={{ width: `${(story.step / Math.max(1, story.total)) * 100}%` }} /></div>
        </div>
      )}
      <span className="small">Offline demo: campaigns and payments are simulated. Wallet actions are disabled, so your real wallet is never contacted.</span>
    </div>
  )
}

function App () {
  const route = useHashRoute()
  const campaign = /^\/c\/([0-9a-f]{64})$/.exec(route)
  return (
    <>
      <Header />
      <DemoBanner />
      <main className="page">
        {campaign !== null ? <Campaign id={campaign[1]} /> : route === '/create' ? <Create /> : route === '/dashboard' ? <Dashboard /> : route === '/donor' ? <Donor /> : <Home />}
      </main>
      <footer className="muted small">
        Donations sit in sCrypt escrow contracts on the BSV blockchain, and your keys stay in your wallet.{' '}
        <a href="https://github.com/bsv-blockchain/bsv-desktop/releases" target="_blank" rel="noreferrer">Get BSV Desktop</a>
      </footer>
    </>
  )
}

createRoot(document.getElementById('root')!).render(<StrictMode><WalletProvider><App /></WalletProvider></StrictMode>)
