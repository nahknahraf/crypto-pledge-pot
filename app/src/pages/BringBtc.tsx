/**
 * "Bring BTC over Lightning": pay the liquidity agent's hold invoice from any Lightning wallet and
 * receive sats in your own BSV wallet. Atomic: the agent can only settle your payment with the secret
 * you reveal when you claim the sats; otherwise the payment fails back. The flow is
 * swap/browserLightning.ts (tested against real LND nodes); this page only shows it.
 *
 * Configured at build time (VITE_LP_LN_URL: an `npm run lp` with BRIDGE_CHAIN=ln). With a WebLN wallet
 * (e.g. Alby) the payment starts by itself; otherwise the page shows the invoice to pay from any wallet.
 */
import { useState } from 'react'
import { ArcadeChainTracker, ARCADE_MAINNET, ARCADE_TESTNET } from '../../../client/arcadeChainTracker'
import { swapLightningToSats, weblnPayer, type WebLn } from '../../../swap/browserLightning'
import { Notice } from '../components/ui'
import { confirmSpend, useWallet } from '../wallet'

const lpUrl = import.meta.env.VITE_LP_LN_URL as string | undefined

export function BringBtc () {
  const { cryptopledgepot, connect, serverNetwork, error } = useWallet()
  const [amount, setAmount] = useState('10000')
  const [lines, setLines] = useState<string[]>([])
  const [invoice, setInvoice] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<boolean>()
  const webln = (window as unknown as { webln?: WebLn }).webln

  if (lpUrl === undefined) {
    return <div className="card"><h2>Bring BTC (Lightning)</h2><p>This server has no Lightning liquidity agent configured. The same flow runs in a terminal with <code>npm run demo:bridge:ln</code>.</p></div>
  }
  const start = async (): Promise<void> => {
    const sats = Number(amount)
    if (!Number.isSafeInteger(sats) || sats <= 0) return
    if (!confirmSpend(`Pay ${sats.toLocaleString('en-US')} sats over Lightning in an atomic swap for sats in your BSV wallet? Your invoice is checked first; if the swap does not complete, the payment fails back to your wallet.`)) return
    setBusy(true); setLines([]); setDone(undefined); setInvoice(undefined)
    const log = (l: string): void => setLines(x => [...x, l])
    try {
      const client = cryptopledgepot ?? await connect()
      if (client === undefined) return
      const tracker = new ArcadeChainTracker(serverNetwork === 'test' ? ARCADE_TESTNET : ARCADE_MAINNET)
      // With WebLN the wallet pays by itself; without it, show the (already checked) invoice to pay by hand.
      const payer = webln !== undefined ? weblnPayer(webln, e => log(`your wallet: ${e.message}`)) : async (inv: string) => { setInvoice(inv) }
      const r = await swapLightningToSats(client.wallet, tracker, { lpUrl, maxRetries: webln !== undefined ? 40 : 200 }, sats, payer, log)
      setDone(r.state === 'claimed')
    } catch (e) {
      log(`stopped: ${(e as Error).message}`); setDone(false)
    } finally { setBusy(false); setInvoice(undefined) }
  }
  return (
    <div className="card">
      <h2>Bring BTC (Lightning)</h2>
      <p className="small muted">Pay from any Lightning wallet and receive sats in your own BSV wallet, with no exchange and no custodian. Before you pay, this page checks that the invoice is locked to your secret, for the agreed amount, to the agent's node.</p>
      {serverNetwork === 'mock' && <Notice kind="err">This is the offline demo; swaps need a real network.</Notice>}
      {error !== undefined && <Notice kind="err">{error}</Notice>}
      <div className="row">
        <input value={amount} onChange={e => setAmount(e.target.value)} inputMode="numeric" style={{ width: '8rem' }} /> <span>sats (BTC)</span>
        <button className="primary" disabled={busy || serverNetwork === 'mock'} onClick={() => { void start() }}>{busy ? 'Swapping…' : 'Swap into BSV sats'}</button>
      </div>
      {invoice !== undefined && (
        <Notice kind="ok">Checked. Pay this invoice from your Lightning wallet: <a href={`lightning:${invoice}`}>open in wallet</a>
          <textarea readOnly value={invoice} rows={4} style={{ width: '100%' }} onFocus={e => e.target.select()} />
        </Notice>
      )}
      <ol className="small">{lines.map((l, i) => <li key={i}>{l}</li>)}</ol>
      {done === true && <Notice kind="ok">The sats are in your BSV wallet. <a href="#/">Back a campaign →</a></Notice>}
    </div>
  )
}
