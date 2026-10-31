/**
 * Giving-routine API (all routes authenticated; mounted after the BRC-103
 * middleware in server/app.ts).
 *
 *   POST /api/routines/interpret       { text }              → { result: ParseResult, interpreter }
 *   GET  /api/routines                                       → Routine[] (the caller's)
 *   POST /api/routines                 { draft }             → Routine
 *   POST /api/routines/:id/status      { status }            → Routine   (active | paused | cancelled)
 *   POST /api/routines/:id/executor    { identityKey|null }  → Routine   (owner: delegate to / revoke a routine agent)
 *   GET  /api/routines/delegated                             → Routine[] (routine agent: what it may run)
 *   POST /api/routines/:id/runs        { pledgeId }          → Routine   (report an execution: owner or executor)
 *
 * What the server does NOT do: it never pays. It cannot, because it holds no
 * key of the user. It stores the instruction and checks reported runs, so the
 * routine's history is an audit trail anyone can follow to the chain:
 *  - the pledge must already be indexed (SPV-verified when it was registered),
 *  - it must be the caller's own pledge, made after the routine was created,
 *    and the caller must be the owner or the routine agent the owner delegated to,
 *  - it must go to a campaign the routine's target allows,
 *  - it must respect the routine's limits (`checkRun`), and count only once.
 *
 * Identity goes through `RoutineOwnerResolver`, never through req.auth directly,
 * so the ZK branch can add a resolver for the `x-zk-proof` header without
 * touching these handlers (see docs/AGENT_ROUTINES_NOTES.md).
 */
import { randomBytes } from 'node:crypto'
import type { Express, Request, Response } from 'express'
import {
  applyRun, canSetStatus, checkRun, isIdentityKey, matchesTarget, newRoutine, ownerKey,
  type OwnerRef, type Routine, type RoutineDraft, type RoutineStatus
} from '../core/routines'
import type { CryptoPledgePotDb } from './db'
import { RuleInterpreter, type RoutineInterpreter } from './routineInterpreter'

/** Header the ZK-auth branch will send: a Groth16 proof (snarkjs) of a registered identity. */
export const ZK_PROOF_HEADER = 'x-zk-proof'

export type RoutineOwnerResolver = (req: Request) => OwnerRef

/**
 * Today: the identity key BRC-103 authenticated. A request that carries an
 * `x-zk-proof` header is refused with 501 rather than silently treated as its
 * BRC-103 identity, so clients built for ZK fail loudly until it is supported.
 */
export const brc103OwnerResolver = (callerIdentityKey: (req: Request) => string): RoutineOwnerResolver => (req) => {
  if (req.get(ZK_PROOF_HEADER) !== undefined) throw Object.assign(new Error(`${ZK_PROOF_HEADER} is not supported by this server yet; sign in with your BSV wallet (BRC-103)`), { status: 501 })
  return { scheme: 'brc103', identityKey: callerIdentityKey(req) }
}

export interface RoutineRouteDeps {
  db: CryptoPledgePotDb
  now: () => number
  /** server/app.ts's handler wrapper: JSON result, HttpError → status. */
  wrap: (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response) => Promise<void>
  /** Throw an HTTP error with this status. */
  fail: (status: number, message: string) => never
  owner: RoutineOwnerResolver
  interpreter?: RoutineInterpreter
}

const ROUTINE_ID = /^[0-9a-f]{32}$/

export function registerRoutineRoutes (app: Express, d: RoutineRouteDeps): void {
  const { db, now, wrap, fail } = d
  const interpreter = d.interpreter ?? new RuleInterpreter()
  const rules = new RuleInterpreter()

  /** The resolver may throw an Error with a status (e.g. 501 for ZK); turn it into an HTTP error. */
  const ownerOf = (req: Request): OwnerRef => {
    try { return d.owner(req) } catch (e) { return fail((e as { status?: number }).status ?? 401, (e as Error).message) }
  }

  /** Load a routine and make sure the caller owns it. 404 either way, so ids of others' routines are not confirmed. */
  async function own (req: Request): Promise<{ owner: OwnerRef, routine: Routine }> {
    const owner = ownerOf(req)
    const id = String(req.params.id)
    const routine = ROUTINE_ID.test(id) ? await db.routine(id) : undefined
    if (routine === undefined || ownerKey(routine.owner) !== ownerKey(owner)) fail(404, 'routine not found')
    return { owner, routine: routine! }
  }

  app.post('/api/routines/interpret', wrap(async (req) => {
    ownerOf(req) // authenticated: the LLM costs money, so anonymous callers can't use it
    const text = String(req.body?.text ?? '').trim()
    if (text === '') fail(400, 'text is required')
    try {
      return { result: await interpreter.interpret(text), interpreter: interpreter.name }
    } catch (e) {
      // LLM unreachable or misbehaving: the rule parser still gives the user an answer.
      console.warn(`routine interpreter ${interpreter.name} failed, using rules: ${(e as Error).message}`)
      return { result: await rules.interpret(text), interpreter: rules.name }
    }
  }))

  app.get('/api/routines', wrap(async (req) => await db.routinesOf(ownerKey(ownerOf(req)))))

  app.post('/api/routines', wrap(async (req) => {
    const owner = ownerOf(req)
    if ((await db.routinesOf(ownerKey(owner))).filter(r => r.status === 'active' || r.status === 'paused').length >= 50) fail(429, 'at most 50 open routines per user')
    let routine: Routine
    try { routine = newRoutine(randomBytes(16).toString('hex'), owner, req.body?.draft as RoutineDraft, now()) } catch (e) { return fail(400, (e as Error).message) }
    await db.putRoutine(routine)
    return routine
  }))

  app.post('/api/routines/:id/status', wrap(async (req) => {
    const { routine } = await own(req)
    const status = req.body?.status as RoutineStatus
    if (!canSetStatus(routine.status, status)) fail(400, `cannot change a ${routine.status} routine to ${String(status)}`)
    // Resuming a routine that missed runs while paused: due now, not once per missed period.
    const next: Routine = { ...routine, status, nextRunAt: status === 'cancelled' ? null : status === 'active' ? Math.min(routine.nextRunAt ?? now(), now()) : routine.nextRunAt }
    await db.putRoutine(next)
    return next
  }))

  /**
   * Delegate automatic execution to the owner's routine agent (its wallet's identity
   * key), or revoke it (null). Only the owner can; the agent itself cannot extend
   * its own powers. Revocation takes effect at once: the next run it reports is refused.
   */
  app.post('/api/routines/:id/executor', wrap(async (req) => {
    const { owner, routine } = await own(req)
    const key = req.body?.identityKey ?? null
    if (key !== null && !isIdentityKey(key)) fail(400, 'identityKey must be a compressed public key (66 hex characters) or null')
    if (key !== null && owner.scheme === 'brc103' && key === owner.identityKey) fail(400, 'that is your own identity: delegate to your routine agent\'s key')
    if (key !== null && (routine.status === 'completed' || routine.status === 'cancelled')) fail(400, `routine is ${routine.status}`)
    const next: Routine = { ...routine, executor: key === null ? null : { identityKey: key, since: now() } }
    await db.putRoutine(next)
    return next
  }))

  /** For a routine agent: the routines delegated to it (its BRC-103 identity), active or not. */
  app.get('/api/routines/delegated', wrap(async (req) => {
    const caller = ownerOf(req)
    if (caller.scheme !== 'brc103') return fail(400, 'routine agents authenticate with BRC-103')
    return await db.routinesExecutedBy(caller.identityKey)
  }))

  app.post('/api/routines/:id/runs', wrap(async (req) => {
    const caller = ownerOf(req)
    const id = String(req.params.id)
    const routine = ROUTINE_ID.test(id) ? await db.routine(id) : undefined
    // The owner, or the routine agent the owner delegated this routine to. Anyone else: 404, as for unknown ids.
    const isOwner = routine !== undefined && ownerKey(routine.owner) === ownerKey(caller)
    const isExecutor = routine?.executor != null && caller.scheme === 'brc103' && routine.executor.identityKey === caller.identityKey
    if (routine === undefined || (!isOwner && !isExecutor)) return fail(404, 'routine not found')
    const pledgeId = String(req.body?.pledgeId ?? '')
    const pledge = await db.pledge(pledgeId)
    if (pledge === undefined) fail(404, 'pledge not found: register the donation first')
    if (caller.scheme !== 'brc103' || pledge!.donorIdentity !== caller.identityKey) fail(403, 'this pledge was not made by you')
    if (pledge!.createdAt < routine.createdAt) fail(400, 'this pledge is older than the routine')
    const already = (await db.routinesOf(ownerKey(routine.owner))).some(r => r.runs.some(run => run.pledgeId === pledge!.id))
    if (already) fail(409, 'this pledge already counts for a routine')
    const c = await db.campaign(pledge!.campaignId)
    if (c === undefined || !matchesTarget(routine.target, c.id, c.meta)) fail(400, 'this campaign does not match the routine\'s target')
    try { checkRun(routine, pledge!.amount, now()) } catch (e) { fail(400, (e as Error).message) }
    const next = applyRun(routine, { at: now(), campaignId: c!.id, campaignTitle: c!.meta.title, sats: pledge!.amount, pledgeId: pledge!.id })
    await db.putRoutine(next)
    return next
  }))
}
