/**
 * CryptoPledgePot indexer + arbiter API.
 *
 * Public (no auth):   campaign list/detail, live SSE feed, pledge state + BEEF.
 * Authenticated:      BRC-103/104 mutual auth (`AuthFetch` on the client), so
 *                     `req.auth.identityKey` is the caller's verified identity:
 *                     create campaign, register pledge, vote, post milestone
 *                     update, request arbiter signatures.
 *
 * The arbiter wallet only ever signs sighashes it computed itself from
 * indexed escrow outputs, and only when the policy (policy.ts) allows it.
 */
import express, { type Express, type Request, type Response } from 'express'
import { createAuthMiddleware, type AuthRequest } from '@bsv/auth-express-middleware'
import { Beef, Hash, OP, PublicKey, Signature, Transaction, TransactionSignature, Utils, type ChainTracker, type WalletInterface } from '@bsv/sdk'
import {
  claimMessage,
  CRYPTOPLEDGEPOT,
  isProtocolTag,
  protocolsFor,
  campaignIdOf,
  LIMITS,
  parseCryptoPledgePotRecord,
  pledgeScriptFor,
  pledgeTerms,
  validateCampaign,
  type CampaignMeta,
  type ProtocolTag
} from '../core/campaign'
import { ALL_SCOPE, cumulativeSchedule, escrowedAfter, METHOD, MIN_PLEDGE, scheduleIsStrict, parsePledgeScript, pledgeLockingScript, preimage } from '../core/pledge'
import type { CampaignDetail, CampaignEvent, ReleasablePledges, SpendablePledge } from '../core/api'
import { CryptoPledgePotDb, type PledgeRow } from './db'
import { connectionCap, rateLimit } from './rateLimit'
import { campaignView, mayRefundEarly, mayRelease, pledgeView } from './policy'

export interface CryptoPledgePotServerOptions {
  /** Arbiter / server wallet: signs as the vote oracle and authenticates the API. */
  wallet: WalletInterface
  db: CryptoPledgePotDb
  /** SPV header source (ArcadeChainTracker in production, the mock chain in tests). */
  chainTracker: ChainTracker
  /** Clock in unix seconds (injectable for tests). */
  now?: () => number
  /** Origin allowed by CORS (default: any). */
  corsOrigin?: string
  /**
   * Which chain this server indexes. 'mock' = the offline demo: the web app
   * then refuses all wallet actions, so a real wallet can never be spent
   * against simulated campaigns.
   */
  network?: 'main' | 'test' | 'mock'
  /**
   * Per-IP limits for public traffic (loopback is exempt).
   * Defaults: 30 SPV-checked submissions/min, 120 authenticated requests/min,
   * 20 open live feeds. `false` disables them.
   */
  limits?: false | { spvPerMinute?: number, authPerMinute?: number, feedsPerIp?: number }
  /**
   * Which proxies may tell us the client IP (X-Forwarded-For), in Express
   * 'trust proxy' syntax. Default 'loopback' (a tunnel or proxy on this machine).
   * Behind Caddy in Docker Compose: 'loopback, uniquelocal' (private networks).
   */
  trustProxy?: string
  /** Live demo only: the story's progress, served at GET /api/demo for the banner. */
  demoStatus?: () => unknown
}

class HttpError extends Error {
  constructor (readonly status: number, message: string) { super(message) }
}

const isHex = (s: unknown, bytes?: number): s is string =>
  typeof s === 'string' && s.length % 2 === 0 && /^[0-9a-f]*$/i.test(s) && (bytes === undefined || s.length === bytes * 2)

function parseAtomic (hex: unknown): { tx: Transaction, bytes: number[] } {
  if (!isHex(hex) || hex.length === 0) throw new HttpError(400, 'beef must be hex AtomicBEEF')
  try {
    const bytes = Utils.toArray(hex, 'hex')
    return { tx: Transaction.fromAtomicBEEF(bytes), bytes }
  } catch (e) {
    throw new HttpError(400, `invalid AtomicBEEF: ${(e as Error).message}`)
  }
}

/** AtomicBEEF, or plain BEEF (e.g. from WhatsOnChain's /tx/{txid}/beef) plus the subject txid. Stored as AtomicBEEF. */
function parseAnyBeef (hex: unknown, txid?: unknown): { tx: Transaction, bytes: number[] } {
  if (!isHex(hex) || hex.length === 0) throw new HttpError(400, 'beef must be hex')
  const raw = Utils.toArray(hex, 'hex')
  try { return { tx: Transaction.fromAtomicBEEF(raw), bytes: raw } } catch { /* plain BEEF */ }
  if (!isHex(txid, 32)) throw new HttpError(400, 'plain BEEF needs the subject txid')
  try {
    const tx = Transaction.fromBEEF(raw, txid.toLowerCase())
    return { tx, bytes: Array.from(tx.toAtomicBEEF()) }
  } catch (e) {
    throw new HttpError(400, `invalid BEEF: ${(e as Error).message}`)
  }
}

const outpointOf = (tx: Transaction, i: number): string =>
  `${tx.inputs[i].sourceTXID ?? tx.inputs[i].sourceTransaction!.id('hex')}.${tx.inputs[i].sourceOutputIndex}`

export interface CryptoPledgePotService {
  app: Express
  /** Index a release or refund (same as POST /api/spends). */
  recordSpend: (tx: Transaction, atomicBeef: number[]) => Promise<{ txid: string, pledges: string[] }>
  /** Index campaigns and original pledges found in a transaction (same as POST /api/import). */
  importTx: (tx: Transaction, atomicBeef: number[]) => Promise<ImportResult>
}

export interface ImportResult { txid: string, campaigns: string[], pledges: string[], skipped: string[] }

export const createCryptoPledgePotApp = (opts: CryptoPledgePotServerOptions): Express => createCryptoPledgePotService(opts).app

export function createCryptoPledgePotService (opts: CryptoPledgePotServerOptions): CryptoPledgePotService {
  const { wallet, db, chainTracker } = opts
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000))
  const app = express()
  // Behind a tunnel or reverse proxy on this machine: take the client IP from
  // X-Forwarded-For, but only when the request came from a loopback proxy.
  app.set('trust proxy', opts.trustProxy ?? 'loopback')
  const limits = opts.limits === false ? undefined : { spvPerMinute: 30, authPerMinute: 120, feedsPerIp: 20, ...opts.limits }
  const pass = (_req: Request, _res: Response, next: () => void): void => { next() }
  const limitSpv = limits !== undefined ? rateLimit({ windowMs: 60_000, max: limits.spvPerMinute, what: 'submissions' }) : pass
  const limitAuth = limits !== undefined ? rateLimit({ windowMs: 60_000, max: limits.authPerMinute, what: 'requests' }) : pass
  const capFeeds = limits !== undefined ? connectionCap(limits.feedsPerIp) : pass

  // ── live feed (SSE) ──
  const listeners = new Map<string, Set<Response>>()
  const emit = (campaignId: string, ev: CampaignEvent): void => {
    for (const res of listeners.get(campaignId) ?? []) res.write(`data: ${JSON.stringify(ev)}\n\n`)
    for (const res of listeners.get('*') ?? []) res.write(`data: ${JSON.stringify({ ...ev, campaignId })}\n\n`)
  }

  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', opts.corsOrigin ?? '*')
    res.setHeader('Access-Control-Allow-Headers', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Expose-Headers', '*')
    if (req.method === 'OPTIONS') { res.sendStatus(204); return }
    next()
  })
  app.use(express.json({ limit: '20mb' }))
  // Body-parser failures (e.g. 413 too large, malformed JSON) as JSON, like every other error.
  app.use((err: any, _req: Request, res: Response, next: (e?: unknown) => void) => {
    if (err?.type === 'entity.too.large') { res.status(413).json({ error: 'request body too large' }); return }
    if (err?.type === 'entity.parse.failed') { res.status(400).json({ error: 'malformed JSON body' }); return }
    next(err)
  })

  const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => async (req: Request, res: Response) => {
    try {
      const out = await fn(req, res)
      if (out !== undefined && !res.headersSent) res.json(out)
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500
      if (status === 500) console.error(e)
      if (!res.headersSent) res.status(status).json({ error: (e as Error).message })
    }
  }

  async function arbiterKey (nonce: string, tag: ProtocolTag = CRYPTOPLEDGEPOT): Promise<string> {
    return (await wallet.getPublicKey({ protocolID: protocolsFor(tag).arbiter, keyID: nonce, counterparty: 'self' })).publicKey
  }

  /** Sign with the arbiter key of the campaign's protocol tag (legacy 'bitfund' campaigns keep their old key). */
  async function arbiterSign (meta: CampaignMeta, sighashPreimage: number[], tag: ProtocolTag): Promise<string> {
    const { signature } = await wallet.createSignature({
      hashToDirectlySign: Hash.hash256(sighashPreimage),
      protocolID: protocolsFor(tag).arbiter,
      keyID: meta.nonce,
      counterparty: 'self'
    })
    const sig = Signature.fromDER([...signature])
    return Utils.toHex(new TransactionSignature(sig.r, sig.s, ALL_SCOPE).toChecksigFormat())
  }

  async function loadView (id: string) {
    const c = await db.campaign(id)
    if (c === undefined) throw new HttpError(404, 'campaign not found')
    const [pledges, releases, updates, votes] = await Promise.all([db.pledges(id), db.releases(id), db.updates(id), db.votes(id)])
    return { c, pledges, view: campaignView(c, pledges, releases, updates, votes, now()) }
  }

  async function spv (tx: Transaction): Promise<void> {
    let ok = false
    try { ok = await tx.verify(chainTracker) } catch (e) { throw new HttpError(400, `SPV verification failed: ${(e as Error).message}`) }
    if (!ok) throw new HttpError(400, 'SPV verification failed')
  }

  /** The escrow output a pledge currently lives in: script and value, from our own index. */
  function escrowSource (meta: CampaignMeta, p: PledgeRow) {
    const terms = pledgeTerms(meta, p.donorKey, p.amount)
    return { satoshis: escrowedAfter(terms, p.stage), lockingScript: pledgeLockingScript(terms) }
  }

  // ════════════════════════════ public ════════════════════════════

  app.get('/api/health', wrap(async () => ({ ok: true, network: opts.network ?? 'main', identityKey: (await wallet.getPublicKey({ identityKey: true })).publicKey, now: now() })))

  app.get('/api/demo', (_req, res) => {
    if (opts.demoStatus === undefined) { res.status(404).json({ error: 'no live demo running' }); return }
    res.json(opts.demoStatus())
  })

  app.get('/api/arbiter-key', wrap(async (req) => {
    const nonce = String(req.query.nonce ?? '')
    if (!isHex(nonce, 16)) throw new HttpError(400, 'nonce must be 16 bytes hex')
    const tag = String(req.query.tag ?? CRYPTOPLEDGEPOT)
    if (!isProtocolTag(tag)) throw new HttpError(400, 'unknown protocol tag')
    return { arbiterKey: await arbiterKey(nonce.toLowerCase(), tag) }
  }))

  /** A transaction the index holds (AtomicBEEF hex), e.g. a campaign anchor, so anyone can verify it by SPV. */
  app.get('/api/txs/:txid', wrap(async (req) => {
    const txid = String(req.params.txid).toLowerCase()
    if (!isHex(txid, 32)) throw new HttpError(400, 'txid must be 32 bytes hex')
    const beef = await db.tx(txid)
    if (beef === undefined) throw new HttpError(404, 'transaction not indexed')
    return { txid, beef }
  }))

  app.get('/api/campaigns', wrap(async () => {
    const all = await db.campaigns()
    return await Promise.all(all.map(async c => (await loadView(c.id)).view))
  }))

  app.get('/api/campaigns/:id', wrap(async (req): Promise<CampaignDetail> => {
    const { c, pledges, view } = await loadView(String(req.params.id))
    return { ...view, feed: pledges.slice(0, 100).map(p => pledgeView(c.meta, p)) }
  }))

  app.get('/api/campaigns/:id/events', capFeeds, (req, res) => {
    const id = String(req.params.id)
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
    res.write(': connected\n\n')
    if (!listeners.has(id)) listeners.set(id, new Set())
    listeners.get(id)!.add(res)
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000)
    req.on('close', () => { clearInterval(ping); listeners.get(id)?.delete(res) })
  })

  app.get('/api/donors/:identityKey/pledges', wrap(async (req) => {
    const rows = await db.pledgesByDonor(String(req.params.identityKey))
    const metas = new Map<string, CampaignMeta>()
    for (const r of rows) if (!metas.has(r.campaignId)) metas.set(r.campaignId, (await db.campaign(r.campaignId))!.meta)
    return rows.map(r => ({ ...pledgeView(metas.get(r.campaignId)!, r), campaignTitle: metas.get(r.campaignId)!.title }))
  }))

  /** Current escrow of a pledge with the BEEF needed to spend it (for refunds). */
  app.get('/api/pledges/:id', wrap(async (req): Promise<SpendablePledge> => {
    const p = await db.pledge(String(req.params.id))
    if (p === undefined) throw new HttpError(404, 'pledge not found')
    const meta = (await db.campaign(p.campaignId))!.meta
    const beef = await db.tx(p.outpoint.split('.')[0])
    return { pledge: pledgeView(meta, p), beef: beef ?? '' }
  }))

  /** Pledges the creator can release next, with one BEEF covering all of them. */
  app.get('/api/campaigns/:id/releasable', wrap(async (req): Promise<ReleasablePledges> => {
    const { c, pledges, view } = await loadView(String(req.params.id))
    const next = view.milestones.find(m => m.approved && pledges.some(p => p.status === 'active' && p.stage === m.index - 1))
    if (next === undefined) return { milestone: 0, pledges: [], beef: '' }
    const ready = pledges.filter(p => p.status === 'active' && p.stage === next.index - 1)
    const beef = new Beef()
    for (const txid of new Set(ready.map(p => p.outpoint.split('.')[0]))) {
      const hex = await db.tx(txid)
      if (hex !== undefined) beef.mergeTransaction(Transaction.fromAtomicBEEF(Utils.toArray(hex, 'hex')))
    }
    return { milestone: next.index, pledges: ready.map(p => pledgeView(c.meta, p)), beef: beef.toHex() }
  }))

  /**
   * Record that a pledge escrow was spent (release or refund). Anyone may report
   * it: the transaction itself is the proof. Public so that a donor's refund is
   * indexed even if they lost access to CryptoPledgePot.
   */
  async function recordSpend (tx: Transaction, bytes: number[]): Promise<{ txid: string, pledges: string[] }> {
    await spv(tx)
    const txid = tx.id('hex')
    const touched: string[] = []
    let releasedSats = 0
    let releaseCampaign: string | undefined
    let releaseMilestone = 0
    for (let i = 0; i < tx.inputs.length; i++) {
      const p = await db.pledgeAt(outpointOf(tx, i))
      if (p === undefined || p.status !== 'active') continue
      const meta = (await db.campaign(p.campaignId))!.meta
      const src = escrowSource(meta, p)
      if (spendMethod(tx, i) === METHOD.release) {
        // SPV ran the contract, so the covenant held: any remainder sits at output i, same script.
        const remaining = escrowedAfter({ pledged: p.amount, cumulativeBps: schedule(meta) }, p.stage + 1)
        await db.updatePledge(p.id, remaining > 0
          ? { outpoint: `${txid}.${i}`, stage: p.stage + 1, spentBy: txid }
          : { status: 'released', stage: p.stage + 1, spentBy: txid })
        releasedSats += src.satoshis - remaining
        releaseCampaign = p.campaignId
        releaseMilestone = p.stage + 1
      } else {
        await db.updatePledge(p.id, { status: 'refunded', spentBy: txid })
        emit(p.campaignId, { type: 'refund', pledgeId: p.id, txid })
      }
      touched.push(p.id)
    }
    if (touched.length === 0) throw new HttpError(400, 'transaction spends no active CryptoPledgePot pledge')
    await db.putTx(txid, Utils.toHex(bytes))
    if (releaseCampaign !== undefined) {
      await db.insertRelease({ campaignId: releaseCampaign, milestone: releaseMilestone, txid, amount: releasedSats, createdAt: now() })
      emit(releaseCampaign, { type: 'release', milestone: releaseMilestone, txid, amount: releasedSats })
    }
    return { txid, pledges: touched }
  }

  /**
   * Rebuild index entries from a transaction on chain: campaign anchors (current
   * or legacy tag, only if they name THIS server's arbiter key) and original
   * pledge escrows of known campaigns. Imported pledges are unclaimed until the
   * donor proves control of the donor key (POST /api/pledges/:id/claim).
   */
  async function importTx (tx: Transaction, bytes: number[]): Promise<ImportResult> {
    await spv(tx)
    const txid = tx.id('hex')
    const result: ImportResult = { txid, campaigns: [], pledges: [], skipped: [] }
    for (const o of tx.outputs) {
      const r = parseCryptoPledgePotRecord(o.lockingScript)
      if (r?.kind !== 'campaign') continue
      try { validateCampaign(r.meta) } catch (e) { result.skipped.push(`campaign ${r.campaignId}: ${(e as Error).message}`); continue }
      if (r.meta.arbiterKey !== await arbiterKey(r.meta.nonce, r.tag)) { result.skipped.push(`campaign ${r.campaignId}: arbiter key is not this server's`); continue }
      if (await db.campaign(r.campaignId) !== undefined) { result.skipped.push(`campaign ${r.campaignId}: already indexed`); continue }
      await db.insertCampaign({ id: r.campaignId, meta: r.meta, creatorIdentity: r.meta.creatorIdentityKey, anchorTxid: txid, createdAt: now(), protocolTag: r.tag })
      result.campaigns.push(r.campaignId)
    }
    for (let i = 0; i < tx.outputs.length; i++) {
      const o = tx.outputs[i]
      const terms = parsePledgeScript(o.lockingScript)
      if (terms === undefined) continue
      const id = `${txid}.${i}`
      const c = await db.campaign(terms.campaignId)
      if (c === undefined) { result.skipped.push(`${id}: campaign ${terms.campaignId} not indexed (import its anchor first)`); continue }
      if (await db.pledge(id) !== undefined || await db.pledgeAt(id) !== undefined) { result.skipped.push(`${id}: already indexed`); continue }
      if (o.satoshis !== terms.pledged) { result.skipped.push(`${id}: a released remainder, not an original pledge`); continue }
      if (pledgeScriptFor(c.meta, terms.donor, terms.pledged).toHex() !== o.lockingScript.toHex()) { result.skipped.push(`${id}: escrow terms do not match the campaign`); continue }
      const memo = tx.outputs.map(x => parseCryptoPledgePotRecord(x.lockingScript)).find(m => m?.kind === 'pledge' && m.campaignId === c.id)
      await db.insertPledge({
        id,
        campaignId: c.id,
        donorIdentity: '',
        donorKey: terms.donor,
        donorKeyId: '',
        amount: terms.pledged,
        name: memo?.kind === 'pledge' ? (memo.memo.name?.slice(0, LIMITS.name) ?? null) : null,
        message: memo?.kind === 'pledge' ? (memo.memo.message?.slice(0, LIMITS.message) ?? null) : null,
        createdAt: now(),
        outpoint: id,
        stage: 0,
        status: 'active',
        spentBy: null
      })
      result.pledges.push(id)
    }
    if (result.campaigns.length + result.pledges.length > 0) await db.putTx(txid, Utils.toHex(bytes))
    return result
  }

  /**
   * Record that a pledge escrow was spent (release or refund). Anyone may report
   * it: the transaction itself is the proof. Public so that a donor's refund is
   * indexed even if they lost access to CryptoPledgePot.
   */
  app.post('/api/spends', limitSpv, wrap(async (req) => {
    const { tx, bytes } = parseAtomic(req.body?.beef)
    return await recordSpend(tx, bytes)
  }))

  /** Rebuild index entries from chain. Body: { beef, txid? } (AtomicBEEF, or plain BEEF + txid). */
  app.post('/api/import', limitSpv, wrap(async (req) => {
    const { tx, bytes } = parseAnyBeef(req.body?.beef, req.body?.txid)
    return await importTx(tx, bytes)
  }))

  // ═════════════════════════ authenticated ═════════════════════════

  app.use(limitAuth)
  app.use(createAuthMiddleware({ wallet, allowUnauthenticated: false }))

  const caller = (req: Request): string => {
    const id = (req as AuthRequest).auth?.identityKey
    if (id === undefined || id === 'unknown') throw new HttpError(401, 'mutual authentication required')
    return id
  }

  /** Register a campaign. Body: { meta, anchorBeef } — the anchor tx carries the campaign's OP_RETURN record. */
  app.post('/api/campaigns', wrap(async (req) => {
    const identity = caller(req)
    const meta = req.body?.meta as CampaignMeta
    try { validateCampaign(meta) } catch (e) { throw new HttpError(400, (e as Error).message) }
    if (meta.creatorIdentityKey !== identity) throw new HttpError(403, 'creatorIdentityKey must be the authenticated identity')
    if (meta.deadline <= now()) throw new HttpError(400, 'deadline must be in the future')
    if (meta.arbiterKey !== await arbiterKey(meta.nonce)) throw new HttpError(400, 'arbiterKey is not this server\'s arbiter key for the nonce')
    const id = campaignIdOf(meta)
    if (await db.campaign(id) !== undefined) throw new HttpError(409, 'campaign already registered')
    const { tx, bytes } = parseAtomic(req.body?.anchorBeef)
    const anchored = tx.outputs.some(o => { const r = parseCryptoPledgePotRecord(o.lockingScript); return r?.kind === 'campaign' && r.tag === CRYPTOPLEDGEPOT && r.campaignId === id })
    if (!anchored) throw new HttpError(400, 'anchor transaction does not carry this campaign\'s record')
    await spv(tx)
    const txid = tx.id('hex')
    await db.putTx(txid, Utils.toHex(bytes))
    await db.insertCampaign({ id, meta, creatorIdentity: identity, anchorTxid: txid, createdAt: now(), protocolTag: CRYPTOPLEDGEPOT })
    return { id, anchorTxid: txid }
  }))

  /** Register a donation. Body: { beef, outputIndex } — AtomicBEEF of the donation tx. */
  app.post('/api/pledges', wrap(async (req) => {
    const identity = caller(req)
    const { tx, bytes } = parseAtomic(req.body?.beef)
    const outputIndex = Number(req.body?.outputIndex)
    const keyID = String(req.body?.keyID ?? '')
    if (!isHex(keyID, 16)) throw new HttpError(400, 'keyID must be 16 bytes hex')
    const out = tx.outputs[outputIndex]
    if (out === undefined) throw new HttpError(400, 'no such output')
    const terms = parsePledgeScript(out.lockingScript)
    if (terms === undefined) throw new HttpError(400, 'output is not a CryptoPledgePot pledge escrow')
    const c = await db.campaign(terms.campaignId)
    if (c === undefined) throw new HttpError(404, 'campaign not found')
    if (now() >= c.meta.deadline) throw new HttpError(400, 'campaign is closed for pledges')
    if (terms.pledged !== out.satoshis) throw new HttpError(400, 'pledge amount does not match its escrow')
    if (terms.pledged < MIN_PLEDGE || !scheduleIsStrict(terms)) throw new HttpError(400, `pledges must be at least ${MIN_PLEDGE} satoshis`)
    if (pledgeScriptFor(c.meta, terms.donor, terms.pledged).toHex() !== out.lockingScript.toHex()) {
      throw new HttpError(400, 'escrow terms do not match the campaign (keys, schedule or refund time)')
    }
    const txid = tx.id('hex')
    const id = `${txid}.${outputIndex}`
    if (await db.pledge(id) !== undefined) throw new HttpError(409, 'pledge already registered')
    await spv(tx)
    const memo = tx.outputs.map(o => parseCryptoPledgePotRecord(o.lockingScript)).find(r => r?.kind === 'pledge' && r.campaignId === c.id)
    const pledge: PledgeRow = {
      id,
      campaignId: c.id,
      donorIdentity: identity,
      donorKey: terms.donor,
      donorKeyId: keyID.toLowerCase(),
      amount: terms.pledged,
      name: memo?.kind === 'pledge' ? (memo.memo.name?.slice(0, LIMITS.name) ?? null) : null,
      message: memo?.kind === 'pledge' ? (memo.memo.message?.slice(0, LIMITS.message) ?? null) : null,
      createdAt: now(),
      outpoint: id,
      stage: 0,
      status: 'active',
      spentBy: null
    }
    await db.putTx(txid, Utils.toHex(bytes))
    await db.insertPledge(pledge)
    const view = pledgeView(c.meta, pledge)
    emit(c.id, { type: 'pledge', pledge: view })
    return view
  }))

  /** Creator posts a progress report for milestone k (opens the donor vote). */
  app.post('/api/campaigns/:id/milestones/:k/update', wrap(async (req) => {
    const identity = caller(req)
    const { c, view } = await loadView(String(req.params.id))
    const k = Number(req.params.k)
    if (identity !== c.meta.creatorIdentityKey) throw new HttpError(403, 'only the creator can post updates')
    if (!Number.isInteger(k) || k < 1 || k > c.meta.milestones.length) throw new HttpError(400, 'no such milestone')
    if (view.milestones[k - 1].released) throw new HttpError(400, 'milestone already released')
    const note = String(req.body?.note ?? '').trim()
    if (note === '' || note.length > LIMITS.description) throw new HttpError(400, 'note must be 1–4000 characters')
    await db.putUpdate({ campaignId: c.id, milestone: k, note, createdAt: now() })
    emit(c.id, { type: 'update', milestone: k })
    return { ok: true }
  }))

  /** Donor vote on milestone k. Weight = the voter's active pledged satoshis. */
  app.post('/api/campaigns/:id/milestones/:k/vote', wrap(async (req) => {
    const identity = caller(req)
    const { c, pledges, view } = await loadView(String(req.params.id))
    const k = Number(req.params.k)
    if (!Number.isInteger(k) || k < 2 || k > c.meta.milestones.length) throw new HttpError(400, 'milestones 2+ are voted on')
    if (view.milestones[k - 1].released) throw new HttpError(400, 'milestone already released')
    if (!pledges.some(p => p.donorIdentity === identity && p.status !== 'refunded')) throw new HttpError(403, 'only donors can vote')
    await db.putVote({ campaignId: c.id, milestone: k, voter: identity, approve: req.body?.approve === true, createdAt: now() })
    emit(c.id, { type: 'vote', milestone: k })
    return { ok: true }
  }))

  /**
   * Arbiter co-signature for a release. Body: { beef } — the creator's
   * unsigned release transaction (signableTransaction.tx). Returns one
   * SIGHASH_ALL signature per pledge input.
   */
  app.post('/api/campaigns/:id/release-signatures', wrap(async (req) => {
    const identity = caller(req)
    const { c, view } = await loadView(String(req.params.id))
    if (identity !== c.meta.creatorIdentityKey) throw new HttpError(403, 'only the creator can release')
    const { tx } = parseAtomic(req.body?.beef)
    const signatures: Record<number, string> = {}
    for (let i = 0; i < tx.inputs.length; i++) {
      const p = await db.pledgeAt(outpointOf(tx, i))
      if (p === undefined || p.campaignId !== c.id) continue
      if (!mayRelease(view, p)) throw new HttpError(403, `milestone ${p.stage + 1} is not approved: ${view.milestones[p.stage]?.pending ?? 'already fully released'}`)
      signatures[i] = await arbiterSign(c.meta, preimage(tx, i, ALL_SCOPE, escrowSource(c.meta, p)), c.protocolTag)
    }
    if (Object.keys(signatures).length === 0) throw new HttpError(400, 'transaction spends no pledge of this campaign')
    return { signatures }
  }))

  /**
   * Claim an imported (or own) pledge for the caller's identity. Body:
   * { keyID, signature } where signature is the donor key's DER signature over
   * sha256(claimMessage(pledgeId, callerIdentity)). Proves control of the escrow's
   * donor key, so votes and arbiter-assisted refunds work for imported pledges.
   */
  app.post('/api/pledges/:id/claim', wrap(async (req) => {
    const identity = caller(req)
    const p = await db.pledge(String(req.params.id))
    if (p === undefined) throw new HttpError(404, 'pledge not found')
    if (p.donorIdentity !== '' && p.donorIdentity !== identity) throw new HttpError(409, 'pledge already claimed by another identity')
    const keyID = String(req.body?.keyID ?? '')
    if (!isHex(keyID, 16)) throw new HttpError(400, 'keyID must be 16 bytes hex')
    let ok = false
    try { ok = PublicKey.fromString(p.donorKey).verify(Utils.toArray(claimMessage(p.id, identity), 'utf8'), Signature.fromDER(Utils.toArray(String(req.body?.signature ?? ''), 'hex'))) } catch { ok = false }
    if (!ok) throw new HttpError(403, 'signature does not prove control of this pledge\'s donor key')
    await db.updatePledge(p.id, { donorIdentity: identity, donorKeyId: keyID.toLowerCase() })
    return { ok: true }
  }))

  /** Arbiter co-signature for an early refund (campaign failed). Body: { beef }. */
  app.post('/api/pledges/:id/refund-signature', wrap(async (req) => {
    const identity = caller(req)
    const p = await db.pledge(String(req.params.id))
    if (p === undefined) throw new HttpError(404, 'pledge not found')
    if (identity !== p.donorIdentity) throw new HttpError(403, 'only the donor can request a refund')
    const { c, view } = await loadView(p.campaignId)
    if (!mayRefundEarly(view, p)) throw new HttpError(403, `early refund needs a failed campaign (status: ${view.status}); after the refund date you can reclaim without CryptoPledgePot`)
    const { tx } = parseAtomic(req.body?.beef)
    const inputIndex = tx.inputs.findIndex((_, i) => outpointOf(tx, i) === p.outpoint)
    if (inputIndex < 0) throw new HttpError(400, 'transaction does not spend this pledge')
    return { inputIndex, signature: await arbiterSign(c.meta, preimage(tx, inputIndex, ALL_SCOPE, escrowSource(c.meta, p)), c.protocolTag) }
  }))

  return { app, recordSpend, importTx }
}

const schedule = (meta: CampaignMeta): number[] => cumulativeSchedule(meta.milestones.map(m => m.percent))

/** Contract method used to spend input i: the selector is the last push of the unlocking script. */
function spendMethod (tx: Transaction, i: number): number {
  const chunks = tx.inputs[i].unlockingScript?.chunks ?? []
  const last = chunks[chunks.length - 1]
  if (last === undefined) return -1
  return last.op === 0 ? 0 : last.op >= OP.OP_1 && last.op <= OP.OP_16 ? last.op - OP.OP_1 + 1 : -1
}
