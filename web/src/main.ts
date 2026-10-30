import { WalletClient } from '@bsv/sdk'
import { OverlayClient, type OutboxStore } from '../../client/overlayApi'
import { TokenKit, type TokenBalance } from '../../client/token'

const OVERLAY_URL = (import.meta as any).env?.VITE_OVERLAY_URL ?? 'http://localhost:8080'
const WOC = 'https://whatsonchain.com/tx/'

const $ = <T extends HTMLElement>(sel: string): T => document.querySelector(sel) as T
const esc = (s: unknown): string => String(s ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`)
const short = (s: string, n = 8): string => (s.length > 2 * n ? `${s.slice(0, n)}…${s.slice(-n)}` : s)
const txLink = (txid: string, label = short(txid)): string => `<a href="${WOC}${esc(txid)}" target="_blank" rel="noopener">${esc(label)}</a>`

function formatAmount (amount: bigint, dec: number): string {
  if (dec === 0) return amount.toString()
  const s = amount.toString().padStart(dec + 1, '0')
  const whole = s.slice(0, -dec)
  const frac = s.slice(-dec).replace(/0+$/, '')
  return frac === '' ? whole : `${whole}.${frac}`
}

function parseAmount (text: string, dec: number): bigint {
  const t = text.trim()
  if (!/^\d+(\.\d+)?$/.test(t)) throw new Error(`invalid amount: "${text}"`)
  const [whole, frac = ''] = t.split('.')
  if (frac.length > dec) throw new Error(`at most ${dec} decimals`)
  return BigInt(whole + frac.padEnd(dec, '0'))
}

/** Outbox persisted in localStorage so a failed overlay submit survives a reload. */
const localOutbox = (key: string): OutboxStore => ({
  load: () => { try { return JSON.parse(localStorage.getItem(key) ?? '[]') } catch { return [] } },
  save: (items) => { try { localStorage.setItem(key, JSON.stringify(items)) } catch { /* private mode */ } }
})

const overlay = new OverlayClient(OVERLAY_URL, localOutbox(`bsv21kit-outbox:${OVERLAY_URL}`))
let kit: TokenKit | undefined
let balances: TokenBalance[] = []
let selectedToken: string | undefined

function log (html: string, isError = false): void {
  const li = document.createElement('li')
  li.innerHTML = `<span class="muted">${new Date().toLocaleTimeString()}</span> ${html}`
  if (isError) li.className = 'err'
  $('#log').prepend(li)
}

async function run (label: string, fn: () => Promise<string | void>): Promise<void> {
  const buttons = [...document.querySelectorAll('button')]
  buttons.forEach(b => { b.dataset.wasDisabled = String(b.disabled); b.disabled = true })
  log(`${esc(label)}… (approve in BSV Desktop if asked)`)
  try {
    const msg = await fn()
    if (msg !== undefined) log(msg)
    await refresh()
  } catch (e: any) {
    log(`${esc(label)} failed: ${esc(e?.message ?? e)}`, true)
    console.error(e)
  } finally {
    buttons.forEach(b => { b.disabled = b.dataset.wasDisabled === 'true' })
    if (kit !== undefined) enableWalletButtons()
  }
}

function enableWalletButtons (): void {
  for (const sel of ['#sync', '#refresh', '#deploy-form button', '#send-form button']) $<HTMLButtonElement>(sel).disabled = false
}

async function checkOverlay (): Promise<void> {
  const chip = $('#overlay-status')
  try {
    const res = await fetch(`${OVERLAY_URL}/listTopicManagers`)
    const topics = await res.json()
    const ok = 'tm_tokenkit' in topics
    chip.textContent = `Overlay: ${ok ? 'OK' : 'no tm_tokenkit'} · ${OVERLAY_URL}`
    chip.className = `chip ${ok ? 'ok' : 'bad'}`
  } catch {
    chip.textContent = `Overlay: not responding (${OVERLAY_URL}) — run npm run overlay`
    chip.className = 'chip bad'
  }
  const pending = overlay.pending()
  if (pending.length > 0) log(`${pending.length} transaction(s) waiting to reach the overlay (retried on Sync): ${pending.map(t => txLink(t.txid)).join(', ')}`)
}

async function refresh (): Promise<void> {
  if (kit === undefined) return
  balances = await kit.balances()
  const tbody = $('#balances')
  tbody.innerHTML = balances.length === 0
    ? '<tr><td colspan="5" class="muted">No tokens yet.</td></tr>'
    : balances.map(b => {
      const dec = Number(b.dec)
      const sel = b.tokenId === selectedToken ? ' class="selected"' : ''
      return `<tr${sel}>
        <td><strong>${esc(b.sym ?? '?')}</strong><br><span class="mono small">${txLink(b.tokenId.split('_')[0], short(b.tokenId, 6))}</span></td>
        <td>${formatAmount(b.overlay, dec)}</td>
        <td>${formatAmount(b.basket, dec)}${b.basket !== b.overlay ? ' <span class="no">≠</span>' : ''}</td>
        <td>${b.utxos}</td>
        <td class="row"><button class="secondary" data-utxos="${esc(b.tokenId)}">UTXOs</button>
            <button class="secondary" data-merge="${esc(b.tokenId)}">Merge</button></td>
      </tr>`
    }).join('')
  const select = $<HTMLSelectElement>('#send-form select')
  const current = select.value
  select.innerHTML = balances.map(b => `<option value="${esc(b.tokenId)}">${esc(b.sym ?? '?')} · ${esc(short(b.tokenId, 6))}</option>`).join('')
  if (balances.some(b => b.tokenId === current)) select.value = current
  if (selectedToken !== undefined) await showUtxos(selectedToken)
}

async function showUtxos (tokenId: string): Promise<void> {
  if (kit === undefined) return
  selectedToken = tokenId
  const b = balances.find(x => x.tokenId === tokenId)
  const dec = Number(b?.dec ?? 0)
  $('#utxo-token').textContent = `${b?.sym ?? ''} · ${short(tokenId, 6)}`
  const utxos = await kit.utxos(tokenId)
  $('#utxos').innerHTML = utxos.length === 0
    ? '<tr><td colspan="5" class="muted">No UTXOs.</td></tr>'
    : utxos.map(u => `<tr>
        <td class="mono small">${txLink(u.txid)}.${u.vout}</td>
        <td>${formatAmount(u.amount, dec)}</td>
        <td>${u.index >= 0 ? `#${u.index}` : '—'}</td>
        <td class="${u.inOverlay ? 'yes' : 'no'}">${u.inOverlay ? '✓' : '✗ not validated'}</td>
        <td class="${u.inBasket ? 'yes' : 'no'}">${u.inBasket ? '✓' : '✗ (Sync)'}</td>
      </tr>`).join('')
}

$('#connect').addEventListener('click', () => void run('Connect', async () => {
  const wallet = new WalletClient('auto')
  const { network } = await wallet.getNetwork({})
  kit = new TokenKit(wallet, overlay)
  const key = await kit.identityKey()
  $('#wallet-status').textContent = `Wallet: ${short(key, 6)} · ${network}`
  $('#wallet-status').className = `chip ${network === 'mainnet' ? 'ok' : 'bad'}`
  $('#identity').innerHTML = `Your identity key: ${esc(key)}`
  if (network !== 'mainnet') log('Warning: the wallet is not on mainnet; the overlay validates against mainnet.', true)
  enableWalletButtons()
  return `Connected (${esc(network)})`
}))

$('#sync').addEventListener('click', () => void run('Sync', async () => {
  const { inserted, relinquished, healed, unvalidated } = await kit!.sync()
  return `Synced: ${inserted.length} UTXO(s) added to the basket, ${relinquished.length} removed` +
    (healed.length > 0 ? `, ${healed.length} transaction(s) recovered from chain (${healed.map(t => txLink(t)).join(', ')})` : '') +
    (unvalidated.length > 0 ? `, ${unvalidated.length} basket UTXO(s) the overlay does NOT validate` : '') + '.'
}))

$('#refresh').addEventListener('click', () => void run('Refresh', async () => {}))

$('#deploy-form').addEventListener('submit', (ev) => {
  ev.preventDefault()
  const f = new FormData(ev.target as HTMLFormElement)
  void run('Create token', async () => {
    const dec = Number(f.get('dec'))
    const amt = parseAmount(String(f.get('amt')), dec)
    const { txid, tokenId } = await kit!.deploy({ sym: String(f.get('sym')).trim(), amt, dec })
    selectedToken = tokenId
    return `Token created: ${esc(tokenId)} (${txLink(txid)})`
  })
})

$('#send-form').addEventListener('submit', (ev) => {
  ev.preventDefault()
  const f = new FormData(ev.target as HTMLFormElement)
  void run('Send', async () => {
    const tokenId = String(f.get('token'))
    const b = balances.find(x => x.tokenId === tokenId)
    if (b === undefined) throw new Error('pick a token')
    const amount = parseAmount(String(f.get('amount')), Number(b.dec))
    const toRaw = String(f.get('to') ?? '').trim()
    if (toRaw !== '' && !/^0[23][0-9a-f]{64}$/i.test(toRaw)) throw new Error('the identity key must be a compressed public key (66 hex)')
    const to = toRaw === '' ? 'self' : toRaw.toLowerCase()
    const { txid, recipientIndex } = await kit!.send(tokenId, amount, to)
    return `Sent ${formatAmount(amount, Number(b.dec))} ${esc(b.sym ?? '')} to ${to === 'self' ? 'yourself' : esc(short(to, 6))} (address #${recipientIndex}) · ${txLink(txid)}`
  })
})

$('#balances').addEventListener('click', (ev) => {
  const el = ev.target as HTMLElement
  if (el.dataset.utxos !== undefined) void run('UTXOs', async () => { await showUtxos(el.dataset.utxos!) })
  if (el.dataset.merge !== undefined) {
    const tokenId = el.dataset.merge
    void run('Merge', async () => {
      const { txid } = await kit!.merge(tokenId)
      return `Merged · ${txLink(txid)}`
    })
  }
})

$('#lookup-form').addEventListener('submit', (ev) => {
  ev.preventDefault()
  const key = String(new FormData(ev.target as HTMLFormElement).get('key')).trim().toLowerCase()
  void (async () => {
    const out = $('#lookup-result')
    try {
      if (!/^0[23][0-9a-f]{64}$/.test(key)) throw new Error('invalid identity key')
      const utxos = await overlay.lookup({ op: 'identity', identityKey: key })
      const byToken = new Map<string, { sym?: string, dec: number, total: bigint, n: number }>()
      for (const u of utxos) {
        const t = byToken.get(u.ctx.tokenId) ?? { sym: u.ctx.sym, dec: Number(u.ctx.dec ?? 0), total: 0n, n: 0 }
        t.total += BigInt(u.ctx.amt)
        t.n++
        byToken.set(u.ctx.tokenId, t)
      }
      out.innerHTML = byToken.size === 0
        ? '<p class="muted">The overlay knows no tokens for this identity key.</p>'
        : `<ul>${[...byToken].map(([id, t]) => `<li><strong>${esc(t.sym ?? '?')}</strong> ${formatAmount(t.total, t.dec)} in ${t.n} UTXO(s) · <span class="mono">${esc(short(id, 6))}</span></li>`).join('')}</ul>`
    } catch (e: any) {
      out.innerHTML = `<p class="no">${esc(e.message)}</p>`
    }
  })()
})

void checkOverlay()
