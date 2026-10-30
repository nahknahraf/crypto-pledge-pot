/**
 * Donate: pledge satoshis into a BitFundPledge escrow from the user's BRC-100
 * wallet. One wallet approval creates the escrow output (tracked in the
 * donor's "bitfund pledges" basket) and an OP_RETURN memo; the indexer then
 * verifies it with SPV and the live feed updates for everyone.
 */
import { useState, type FormEvent } from 'react'
import type { CampaignMeta } from '../../../core/campaign'
import { MIN_PLEDGE } from '../../../core/pledge'
import { formatSats, formatUsd, useBsvPrice, WOC_TX } from '../format'
import { useWallet } from '../wallet'

const PRESETS = [1_000, 10_000, 100_000, 1_000_000]

export function DonateButton ({ meta, onDonated }: { meta: CampaignMeta, onDonated?: () => void }) {
  const { connect, connecting } = useWallet()
  const price = useBsvPrice()
  const [amount, setAmount] = useState(10_000)
  const [name, setName] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ ok: boolean, text: string, txid?: string }>()

  async function submit (e: FormEvent) {
    e.preventDefault()
    setResult(undefined)
    if (!Number.isSafeInteger(amount) || amount < MIN_PLEDGE) {
      setResult({ ok: false, text: `Minimum pledge is ${MIN_PLEDGE} sats.` })
      return
    }
    const bf = await connect()
    if (bf === undefined) return
    setBusy(true)
    try {
      const p = await bf.donate(meta, amount, { name, message })
      setResult({ ok: true, text: `Pledged ${formatSats(p.amount)}. It is held in escrow until milestones are approved.`, txid: p.id.split('.')[0] })
      setMessage('')
      onDonated?.()
    } catch (err) {
      setResult({ ok: false, text: (err as Error).message })
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="donate" onSubmit={e => { void submit(e) }}>
      <h3>Back this campaign</h3>
      <div className="presets">
        {PRESETS.map(p => (
          <button type="button" key={p} className={p === amount ? 'chip active' : 'chip'} onClick={() => setAmount(p)}>{formatSats(p)}</button>
        ))}
      </div>
      <label>Amount (sats)
        <input type="number" min={MIN_PLEDGE} step={1} value={amount} onChange={e => setAmount(Math.floor(Number(e.target.value)))} />
      </label>
      {formatUsd(amount, price) !== undefined && <p className="muted small">≈ {formatUsd(amount, price)} · network fee well under a cent</p>}
      <label>Name (optional, public)<input value={name} maxLength={40} onChange={e => setName(e.target.value)} /></label>
      <label>Message (optional, written on chain)<textarea value={message} maxLength={280} rows={2} onChange={e => setMessage(e.target.value)} /></label>
      <button type="submit" className="primary" disabled={busy || connecting}>
        {busy ? 'Approve in your wallet…' : connecting ? 'Connecting…' : `Donate ${formatSats(amount)}`}
      </button>
      <p className="muted small">
        Your sats go into an on-chain escrow, not to the creator. They are released milestone by milestone; if the campaign fails,
        or nothing has been released by {new Date(meta.refundAfter * 1000).toLocaleDateString()}, you can reclaim them.
      </p>
      {result !== undefined && (
        <p className={result.ok ? 'ok' : 'err'}>
          {result.text} {result.txid !== undefined && <a href={WOC_TX + result.txid} target="_blank" rel="noreferrer">View transaction</a>}
        </p>
      )}
    </form>
  )
}
