/**
 * "Bring BTC": two ways in. (1) Lightning: pay the liquidity agent's hold invoice from any Lightning wallet and
 * receive sats in your own BSV wallet. Atomic: the agent can only settle your payment with the secret
 * you reveal when you claim the sats; otherwise the payment fails back. The flow is
 * swap/browserLightning.ts (tested against real LND nodes); this page only shows it.
 *
 * Configured at build time (VITE_LP_LN_URL: an `npm run lp` with BRIDGE_CHAIN=ln). With a WebLN wallet
 * (e.g. Alby) the payment starts by itself; otherwise the page shows the invoice to pay from any wallet.
 * (2) On chain (VITE_LP_BTC_URL, VITE_BTC_NETWORK=main|test, VITE_BTC_ESPLORA_URL): the page makes a refund
 * ticket to save, shows the HTLC address to pay from any wallet, and can refund with the ticket after the
 * timeout (swap/browserBtc.ts, tested on regtest).
 */
import { useState } from 'react'
import { ArcadeChainTracker, ARCADE_MAINNET, ARCADE_TESTNET } from '../../../client/arcadeChainTracker'
import { refundBtc, swapBtcToSats, type BtcRefundTicket } from '../../../swap/browserBtc'
import { swapLightningToSats, weblnPayer, type WebLn } from '../../../swap/browserLightning'
import { Notice } from '../components/ui'
import { confirmSpend, useWallet } from '../wallet'

const lpUrl = import.meta.env.VITE_LP_LN_URL as string | undefined
const btcLpUrl = import.meta.env.VITE_LP_BTC_URL as string | undefined
const btcNetwork = import.meta.env.VITE_BTC_NETWORK === 'test' ? 'test' as const : 'main' as const
const esploraUrl = (import.meta.env.VITE_BTC_ESPLORA_URL as string | undefined) ?? (btcNetwork === 'test' ? 'https://mempool.space/signet/api' : 'https://mempool.space/api')

export function BringBtc () {
  return <>{lpUrl !== undefined || btcLpUrl === undefined ? <BringLightning /> : null}{btcLpUrl !== undefined && <BringOnChain lpUrl={btcLpUrl} />}</>
}

function BringLightning () {
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

function BringOnChain ({ lpUrl }: { lpUrl: string }) {
  const { cryptopledgepot, connect, serverNetwork } = useWallet()
  const [amount, setAmount] = useState('20000')
  const [refundTo, setRefundTo] = useState('')
  const [lines, setLines] = useState<string[]>([])
  const [ticket, setTicket] = useState<BtcRefundTicket>()
  const [payTo, setPayTo] = useState<{ address: string, sats: number, paid: () => void }>()
  const [refundText, setRefundText] = useState('')
  const [busy, setBusy] = useState(false)
  const log = (l: string): void => setLines(x => [...x, l])
  const ticketHref = ticket === undefined ? undefined : `data:application/json,${encodeURIComponent(JSON.stringify(ticket))}`

  const start = async (): Promise<void> => {
    const sats = Number(amount)
    if (!Number.isSafeInteger(sats) || sats <= 0 || refundTo.trim() === '') return
    if (!confirmSpend(`Swap ${sats.toLocaleString('en-US')} BTC sats (on chain) for sats in your BSV wallet? You will get a refund ticket to SAVE: it is the only way to get your BTC back if the swap fails.`)) return
    setBusy(true); setLines([])
    try {
      const client = cryptopledgepot ?? await connect()
      if (client === undefined) return
      const tracker = new ArcadeChainTracker(serverNetwork === 'test' ? ARCADE_TESTNET : ARCADE_MAINNET)
      // pay(): show the address and wait for the donor to say they sent it; the page then finds it on chain.
      const pay = async (address: string, s: number): Promise<void> => { await new Promise<void>(resolve => setPayTo({ address, sats: s, paid: resolve })); setPayTo(undefined); log('looking for your payment on chain…') }
      const { record } = await swapBtcToSats(client.wallet, tracker, { lpUrl, network: btcNetwork, esploraUrl, refundTo: refundTo.trim() }, sats, pay, t => setTicket({ ...t }), log)
      if (record.state === 'claimed') log('done: the sats are in your BSV wallet')
    } catch (e) { log(`stopped: ${(e as Error).message}`) } finally { setBusy(false) }
  }
  const refund = async (): Promise<void> => {
    try { await refundBtc(JSON.parse(refundText) as BtcRefundTicket, { esploraUrl }); log('refund sent to your address') } catch (e) { log(`refund: ${(e as Error).message}`) }
  }
  return (
    <div className="card">
      <h2>Bring BTC (on chain)</h2>
      <p className="small muted">Pay from any Bitcoin wallet. Your BTC goes into a hash-time-locked output: only the liquidity agent can take it, and only with the secret you reveal when you claim your BSV sats; otherwise you take it back after the timeout with your refund ticket.</p>
      {serverNetwork === 'mock' && <Notice kind="err">This is the offline demo; swaps need a real network.</Notice>}
      <div className="row">
        <input value={amount} onChange={e => setAmount(e.target.value)} inputMode="numeric" style={{ width: '8rem' }} /> <span>BTC sats</span>
        <input value={refundTo} onChange={e => setRefundTo(e.target.value)} placeholder={`your refund address (${btcNetwork === 'main' ? 'bc1…' : 'tb1…'})`} style={{ flex: 1 }} />
        <button className="primary" disabled={busy || serverNetwork === 'mock'} onClick={() => { void start() }}>{busy ? 'Swapping…' : 'Swap into BSV sats'}</button>
      </div>
      {ticket !== undefined && <Notice kind="info">Your refund ticket: <a href={ticketHref} download="cryptopledgepot-btc-refund-ticket.json">save it now</a>. Keep it private until the swap is done.</Notice>}
      {payTo !== undefined && (
        <Notice kind="ok">Pay exactly <b>{payTo.sats.toLocaleString('en-US')} sats</b> to <code>{payTo.address}</code> (<a href={`bitcoin:${payTo.address}?amount=${(payTo.sats / 1e8).toFixed(8)}`}>open in wallet</a>), then <button onClick={payTo.paid}>I have paid</button></Notice>
      )}
      <ol className="small">{lines.map((l, i) => <li key={i}>{l}</li>)}</ol>
      <details><summary className="small">Refund with a ticket (after the timeout)</summary>
        <textarea value={refundText} onChange={e => setRefundText(e.target.value)} rows={3} style={{ width: '100%' }} placeholder="paste the ticket JSON" />
        <button onClick={() => { void refund() }}>Refund</button>
      </details>
    </div>
  )
}
