import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Campaign } from './pages/Campaign'
import { Create } from './pages/Create'
import { Dashboard } from './pages/Dashboard'
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
  const { identityKey, network, connect, connecting } = useWallet()
  return (
    <header className="top">
      <a className="logo" href="#/">Crypto<span>PledgePot</span></a>
      <nav>
        <a href="#/">Campaigns</a>
        <a href="#/create">Start a campaign</a>
        <a href="#/dashboard">Dashboard</a>
      </nav>
      {identityKey !== undefined
        ? <span className="chip" title={identityKey}>● {network === 'testnet' ? 'testnet · ' : ''}{short(identityKey)}</span>
        : <button className="primary" disabled={connecting} onClick={() => { void connect() }}>{connecting ? 'Connecting…' : 'Connect wallet'}</button>}
    </header>
  )
}

function App () {
  const route = useHashRoute()
  const campaign = /^\/c\/([0-9a-f]{64})$/.exec(route)
  return (
    <>
      <Header />
      <main className="page">
        {campaign !== null ? <Campaign id={campaign[1]} /> : route === '/create' ? <Create /> : route === '/dashboard' ? <Dashboard /> : <Home />}
      </main>
      <footer className="muted small">
        Donations sit in sCrypt escrow contracts on the BSV blockchain, and your keys stay in your wallet.{' '}
        <a href="https://github.com/bsv-blockchain/bsv-desktop/releases" target="_blank" rel="noreferrer">Get BSV Desktop</a>
      </footer>
    </>
  )
}

createRoot(document.getElementById('root')!).render(<StrictMode><WalletProvider><App /></WalletProvider></StrictMode>)
