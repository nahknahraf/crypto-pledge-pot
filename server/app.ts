/**
 * BitFund indexer + arbiter API.
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
import { Beef, Hash, OP, Signature, Transaction, TransactionSignature, Utils, type ChainTracker, type WalletInterface } from '@bsv/sdk'
import {
  ARBITER_PROTOCOL,
  campaignIdOf,
  LIMITS,
  parseBitfundRecord,
  pledgeScriptFor,
  pledgeTerms,
  validateCampaign,
  type CampaignMeta
} from '../core/campaign'
import { ALL_SCOPE, cumulativeSchedule, escrowedAfter, METHOD, MIN_PLEDGE, scheduleIsStrict, parsePledgeScript, pledgeLockingScript, preimage } from '../core/pledge'
import type { CampaignDetail, CampaignEvent, ReleasablePledges, SpendablePledge } from '../core/api'
import { BitFundDb, type PledgeRow } from './db'
import { campaignView, mayRefundEarly, mayRelease, pledgeView } from './policy'

export interface BitFundServerOptions {
  /** Arbiter / server wallet: signs as the vote oracle and authenticates the API. */
  wallet: WalletInterface
  db: BitFundDb
  /** SPV header source (ArcadeChainTracker in production, the mock chain in tests). */
  chainTracker: ChainTracker
  /** Clock in unix seconds (injectable for tests). */
  now?: () => number
  /** Origin allowed by CORS (default: any). */
  corsOrigin?: string
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

const outpointOf = (tx: Transaction, i: number): string =>
  `${tx.inputs[i].sourceTXID ?? tx.inputs[i].sourceTransaction!.id('hex')}.${tx.inputs[i].sourceOutputIndex}`

export function createBitFundApp (opts: BitFundServerOptions): Express {
  const { wallet, db, chainTracker } = opts
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000))
  const app = express()

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

  async function arbiterKey (nonce: string): Promise<string> {
    return (await wallet.getPublicKey({ protocolID: ARBITER_PROTOCOL, keyID: nonce, counterparty: 'self' })).publicKey
  }

  async function arbiterSign (meta: CampaignMeta, sighashPreimage: number[]): Promise<string> {
    const { signature } = await wallet.createSignature({
      hashToDirectlySign: Hash.hash256(sighashPreimage),
      protocolID: ARBITER_PROTOCOL,
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

  app.get('/api/health', wrap(async () => ({ ok: true, identityKey: (await wallet.getPublicKey({ identityKey: true })).publicKey, now: now() })))

  app.get('/api/arbiter-key', wrap(async (req) => {
    const nonce = String(req.query.nonce ?? '')
    if (!isHex(nonce, 16)) throw new HttpError(400, 'nonce must be 16 bytes hex')
    return { arbiterKey: await arbiterKey(nonce.toLowerCase()) }
  }))

  app.get('/api/campaigns', wrap(async () => {
    const all = await db.campaigns()
    return await Promise.all(all.map(async c => (await loadView(c.id)).view))
  }))

  app.get('/api/campaigns/:id', wrap(async (req): Promise<CampaignDetail> => {
    const { c, pledges, view } = await loadView(String(req.params.id))
    return { ...view, feed: pledges.slice(0, 100).map(p => pledgeView(c.meta, p)) }
  }))

  app.get('/api/campaigns/:id/events', (req, res) => {
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
   * indexed even if they lost access to BitFund.
   */
  app.post('/api/spends', wrap(async (req) => {
    const { tx, bytes } = parseAtomic(req.body?.beef)
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
    if (touched.length === 0) throw new HttpError(400, 'transaction spends no active BitFund pledge')
    await db.putTx(txid, Utils.toHex(bytes))
    if (releaseCampaign !== undefined) {
      await db.insertRelease({ campaignId: releaseCampaign, milestone: releaseMilestone, txid, amount: releasedSats, createdAt: now() })
      emit(releaseCampaign, { type: 'release', milestone: releaseMilestone, txid, amount: releasedSats })
    }
    return { txid, pledges: touched }
  }))

  // ═════════════════════════ authenticated ═════════════════════════

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
    const anchored = tx.outputs.some(o => { const r = parseBitfundRecord(o.lockingScript); return r?.kind === 'campaign' && r.campaignId === id })
    if (!anchored) throw new HttpError(400, 'anchor transaction does not carry this campaign\'s record')
    await spv(tx)
    const txid = tx.id('hex')
    await db.putTx(txid, Utils.toHex(bytes))
    await db.insertCampaign({ id, meta, creatorIdentity: identity, anchorTxid: txid, createdAt: now() })
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
    if (terms === undefined) throw new HttpError(400, 'output is not a BitFund pledge escrow')
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
    const memo = tx.outputs.map(o => parseBitfundRecord(o.lockingScript)).find(r => r?.kind === 'pledge' && r.campaignId === c.id)
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
      signatures[i] = await arbiterSign(c.meta, preimage(tx, i, ALL_SCOPE, escrowSource(c.meta, p)))
    }
    if (Object.keys(signatures).length === 0) throw new HttpError(400, 'transaction spends no pledge of this campaign')
    return { signatures }
  }))

  /** Arbiter co-signature for an early refund (campaign failed). Body: { beef }. */
  app.post('/api/pledges/:id/refund-signature', wrap(async (req) => {
    const identity = caller(req)
    const p = await db.pledge(String(req.params.id))
    if (p === undefined) throw new HttpError(404, 'pledge not found')
    if (identity !== p.donorIdentity) throw new HttpError(403, 'only the donor can request a refund')
    const { c, view } = await loadView(p.campaignId)
    if (!mayRefundEarly(view, p)) throw new HttpError(403, `early refund needs a failed campaign (status: ${view.status}); after the refund date you can reclaim without BitFund`)
    const { tx } = parseAtomic(req.body?.beef)
    const inputIndex = tx.inputs.findIndex((_, i) => outpointOf(tx, i) === p.outpoint)
    if (inputIndex < 0) throw new HttpError(400, 'transaction does not spend this pledge')
    return { inputIndex, signature: await arbiterSign(c.meta, preimage(tx, inputIndex, ALL_SCOPE, escrowSource(c.meta, p))) }
  }))

  return app
}

const schedule = (meta: CampaignMeta): number[] => cumulativeSchedule(meta.milestones.map(m => m.percent))

/** Contract method used to spend input i: the selector is the last push of the unlocking script. */
function spendMethod (tx: Transaction, i: number): number {
  const chunks = tx.inputs[i].unlockingScript?.chunks ?? []
  const last = chunks[chunks.length - 1]
  if (last === undefined) return -1
  return last.op === 0 ? 0 : last.op >= OP.OP_1 && last.op <= OP.OP_16 ? last.op - OP.OP_1 + 1 : -1
}
