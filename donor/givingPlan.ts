/**
 * Giving plans: "for a year, every month, give 5,000 sats to a campaign for
 * children in need". The donor agent carries the plan out on its own.
 *
 * Every installment, when it falls due:
 *  1. search the open campaigns for the plan's cause (donor/search.ts);
 *  2. keep only campaigns that pass the donor's hard rules (screen.ts) and the
 *     due diligence (anchor verified by SPV, the platform's arbiter);
 *  3. decide:
 *     - a good match (relevance ≥ goodMatch, default 70): give, on its own;
 *     - only a weaker match (≥ minMatch, default 40): do what the plan says:
 *       'ask' the donor (default), give to the 'closest' match, or 'skip';
 *     - nothing similar: ask the donor (or skip, if the plan says so);
 *  4. a question waits askTimeoutHours (default 72) for an answer; then the
 *     plan's onNoAnswer applies (skip, or give to the closest match).
 *
 * In autopilot the agent pledges from its budget wallet. In co-pilot every
 * installment becomes a proposal the donor approves and pays on the "My donor
 * agent" page. Amounts come from the plan and are capped by the mandate's
 * budget, per-pledge and per-creator limits; the model never sets them.
 */
import Anthropic from '@anthropic-ai/sdk'
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod'
import { z } from 'zod'
import type { CampaignView } from '../core/api'
import type { Store } from '../agent/ledger'
import { checkAnchor, checkArbiter } from './diligence'
import type { DonorAgent } from './donorAgent'
import type { Inbox, Message, Option } from './inbox'
import { creatorRecord, screen } from './screen'
import { QUERY_MAX, type CampaignMatch } from './search'

export type Cadence = 'daily' | 'weekly' | 'monthly'
/** What to do when the best campaign is only a weaker match. */
export type WeakMatch = 'ask' | 'closest' | 'skip'

export interface GivingPlanInput {
  /** What to support, in a few words (the search query). */
  cause: string
  /** Satoshis per installment. */
  amountSats: number
  cadence: Cadence
  /** Number of installments (12 monthly = a year). */
  occurrences: number
  /** First installment (unix seconds; default: now). */
  startAt?: number
  onWeakMatch?: WeakMatch
  /** Relevance (0–100) at which the agent gives without asking (default 70). */
  goodMatch?: number
  /** Below this relevance nothing counts as similar (default 40). */
  minMatch?: number
  /** How long a question waits for the donor (default 72 hours). */
  askTimeoutHours?: number
  /** When a question expires: skip this installment, or give to the closest match (default skip). */
  onNoAnswer?: 'skip' | 'closest'
  /** Prefer campaigns this plan has not given to yet (default true). */
  preferNew?: boolean
  /** The donor's own words, if the plan was written in plain language. */
  text?: string
}

export type InstallmentStatus = 'due' | 'asked' | 'proposed' | 'given' | 'skipped' | 'failed'

export interface Installment {
  n: number
  dueAt: number
  status: InstallmentStatus
  campaignId?: string
  campaignTitle?: string
  relevance?: number
  amount?: number
  memoId?: string
  questionId?: string
  note?: string
}

export interface GivingPlan extends Required<Omit<GivingPlanInput, 'text'>> {
  id: string
  text?: string
  createdAt: number
  status: 'active' | 'paused' | 'completed' | 'cancelled'
  installments: Installment[]
}

export interface PlanStepSummary { due: number, given: number, proposed: number, asked: number, skipped: number }

const DAY = 86_400
const MIN_PLEDGE = 100
const isInt = (n: unknown, min: number, max: number): boolean => Number.isSafeInteger(n) && (n as number) >= min && (n as number) <= max
const fmt = (n: number): string => n.toLocaleString('en-US')
const CADENCE_WORD: Record<Cadence, string> = { daily: 'day', weekly: 'week', monthly: 'month' }

/** Same day next month(s), clamped to the month's last day (31 Jan + 1 month = 28/29 Feb). */
export function addMonths (t: number, months: number): number {
  const d = new Date(t * 1000)
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1, d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()))
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate()
  target.setUTCDate(Math.min(d.getUTCDate(), last))
  return Math.floor(target.getTime() / 1000)
}

export const dueDate = (start: number, cadence: Cadence, i: number): number =>
  cadence === 'monthly' ? addMonths(start, i) : start + i * (cadence === 'weekly' ? 7 : 1) * DAY

/** One sentence the donor can check before confirming. */
export function describePlan (p: GivingPlanInput): string {
  const weak = { ask: 'asks you first', closest: 'gives to the closest match on its own', skip: 'skips that installment' }[p.onWeakMatch ?? 'ask']
  return `Every ${CADENCE_WORD[p.cadence]}, ${p.occurrences} time(s): ${fmt(p.amountSats)} sats to a campaign about "${p.cause}" ` +
    `(${fmt(p.amountSats * p.occurrences)} sats in total). A good match (≥ ${p.goodMatch ?? 70}%): your agent gives on its own. ` +
    `Only a weaker match: it ${weak}. Nothing similar: it asks you. Unanswered after ${p.askTimeoutHours ?? 72} h: it ${p.onNoAnswer === 'closest' ? 'gives to the closest match' : 'skips'}.`
}

export interface PlannerDeps {
  plans: Store<GivingPlan[]>
  inbox: Inbox
  /** Push a message to the donor (webhook to their phone…). Failures are logged, never fatal. */
  notify?: (m: Message) => Promise<void>
  now?: () => number
  log?: (line: string) => void
}

interface Candidate { match: CampaignMatch, campaign: CampaignView }

export class GivingPlanner {
  private readonly log: (line: string) => void
  private readonly now: () => number

  constructor (readonly agent: DonorAgent, readonly deps: PlannerDeps) {
    this.log = deps.log ?? (line => console.log(`[plans] ${line}`))
    this.now = deps.now ?? agent.deps.now ?? (() => Math.floor(Date.now() / 1000))
  }

  plans (): GivingPlan[] { return this.deps.plans.load() }
  get (id: string): GivingPlan | undefined { return this.plans().find(p => p.id === id) }

  private save (plan: GivingPlan): GivingPlan {
    const all = this.plans()
    const i = all.findIndex(p => p.id === plan.id)
    if (i < 0) all.push(plan); else all[i] = plan
    this.deps.plans.save(all)
    return plan
  }

  /** Sats the active plans will still give (installments not yet given, skipped or failed). */
  committed (exceptId?: string): number {
    return this.plans().filter(p => p.status === 'active' && p.id !== exceptId)
      .reduce((s, p) => s + p.installments.filter(i => i.status === 'due' || i.status === 'asked').length * p.amountSats, 0)
  }

  /** Validate against the mandate and save. Throws a readable error for anything unsafe. */
  create (input: GivingPlanInput): GivingPlan {
    const m = this.agent.mandate
    const fail = (msg: string): never => { throw new Error(`invalid giving plan: ${msg}`) }
    const p = {
      onWeakMatch: 'ask' as WeakMatch, goodMatch: 70, minMatch: 40, askTimeoutHours: 72, onNoAnswer: 'skip' as const, preferNew: true, startAt: this.now(),
      ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined))
    } as Required<GivingPlanInput>
    if (typeof p.cause !== 'string' || p.cause.trim() === '' || p.cause.length > QUERY_MAX) fail(`say in 1–${QUERY_MAX} characters what to support`)
    if (!isInt(p.amountSats, MIN_PLEDGE, m.budget.perPledgeMaxSats)) fail(`amountSats must be ${MIN_PLEDGE}–${fmt(m.budget.perPledgeMaxSats)} sats (your per-pledge limit)`)
    if (!['daily', 'weekly', 'monthly'].includes(p.cadence)) fail('cadence must be daily, weekly or monthly')
    if (!isInt(p.occurrences, 1, 120)) fail('occurrences must be 1–120')
    if (!isInt(p.startAt, 0, 0xffffffff)) fail('startAt must be unix seconds')
    if (!['ask', 'closest', 'skip'].includes(p.onWeakMatch)) fail('onWeakMatch must be ask, closest or skip')
    if (!isInt(p.goodMatch, 1, 100) || !isInt(p.minMatch, 1, 100) || p.minMatch > p.goodMatch) fail('need 1 ≤ minMatch ≤ goodMatch ≤ 100')
    if (!isInt(p.askTimeoutHours, 1, 720)) fail('askTimeoutHours must be 1–720')
    if (p.onNoAnswer !== 'skip' && p.onNoAnswer !== 'closest') fail('onNoAnswer must be skip or closest')
    if (typeof p.preferNew !== 'boolean') fail('preferNew must be true or false')
    const left = m.budget.totalSats - this.agent.portfolio().total - this.committed()
    const total = p.amountSats * p.occurrences
    if (total > left) fail(`the plan needs ${fmt(total)} sats but only ${fmt(Math.max(0, left))} of your budget is free`)
    const now = this.now()
    const plan: GivingPlan = {
      ...p,
      cause: p.cause.trim(),
      text: input.text?.slice(0, 1000),
      id: `plan${this.plans().length + 1}`,
      createdAt: now,
      status: 'active',
      installments: Array.from({ length: p.occurrences }, (_, i) => ({ n: i + 1, dueAt: dueDate(p.startAt, p.cadence, i), status: 'due' as const }))
    }
    this.log(`new plan ${plan.id}: ${describePlan(plan)}`)
    return this.save(plan)
  }

  setStatus (id: string, status: 'active' | 'paused' | 'cancelled'): GivingPlan {
    const plan = this.get(id)
    if (plan === undefined) throw new Error(`no plan ${id}`)
    if (plan.status === 'completed' || plan.status === 'cancelled') throw new Error(`the plan is ${plan.status}`)
    return this.save({ ...plan, status })
  }

  private async say (m: Omit<Message, 'id' | 'at'>): Promise<Message> {
    const msg = this.deps.inbox.add(m, this.now())
    this.log(msg.text)
    await this.deps.notify?.(msg).catch(e => this.log(`could not deliver message ${msg.id}: ${(e as Error).message}`))
    return msg
  }

  async step (): Promise<PlanStepSummary> {
    const s: PlanStepSummary = { due: 0, given: 0, proposed: 0, asked: 0, skipped: 0 }
    const now = this.now()
    for (const original of this.plans()) {
      if (original.status !== 'active') continue
      let plan = this.syncProposals(original)
      // Expired questions first.
      for (const inst of plan.installments.filter(i => i.status === 'asked')) {
        const q = this.deps.inbox.get(inst.questionId ?? '')
        if (q?.status !== 'open' || q.expiresAt === undefined || now < q.expiresAt) continue
        this.deps.inbox.update(q.id, { status: 'expired' })
        if (plan.onNoAnswer === 'closest' && (q.options?.length ?? 0) > 0) {
          const c = await this.stillEligible(plan, q.options![0].campaignId)
          if (c !== undefined) { plan = await this.give(plan, inst, c, 'no answer in time, so the closest match'); continue }
        }
        plan = await this.skip(plan, inst, 'no answer in time')
      }
      // One due installment per plan per round: an agent that was offline catches up gradually.
      const next = plan.installments.find(i => i.status === 'due' && i.dueAt <= now)
      if (next !== undefined) {
        s.due++
        plan = await this.run(plan, next)
        const st = plan.installments[next.n - 1].status
        if (st === 'given') s.given++
        else if (st === 'proposed') s.proposed++
        else if (st === 'asked') s.asked++
        else if (st === 'skipped') s.skipped++
      }
      if (plan.status === 'active' && plan.installments.every(i => i.status === 'given' || i.status === 'skipped' || i.status === 'failed')) {
        const given = plan.installments.filter(i => i.status === 'given')
        plan = this.save({ ...plan, status: 'completed' })
        await this.say({ kind: 'info', status: 'info', planId: plan.id, text: `Giving plan "${plan.cause}" finished: ${given.length} of ${plan.occurrences} installment(s) given, ${fmt(given.reduce((t, i) => t + (i.amount ?? 0), 0))} sats in total.` })
      }
    }
    return s
  }

  /** Co-pilot: follow the donor's decisions on proposals. */
  private syncProposals (plan: GivingPlan): GivingPlan {
    let changed = false
    const installments = plan.installments.map(i => {
      if (i.status !== 'proposed' || i.memoId === undefined) return i
      const memo = this.agent.deps.memos.get(i.memoId)
      if (memo?.status === 'executed') { changed = true; return { ...i, status: 'given' as const, amount: memo.amount } }
      if (memo?.status === 'declined') { changed = true; return { ...i, status: 'skipped' as const, note: 'you declined the proposal' } }
      return i
    })
    return changed ? this.save({ ...plan, installments }) : plan
  }

  /** Campaigns for the plan's cause that pass the donor's rules and the due diligence, best first. */
  private async candidates (plan: GivingPlan): Promise<Candidate[]> {
    const now = this.now()
    const all = await this.agent.deps.api.campaigns()
    const byId = new Map(all.map(c => [c.id, c]))
    const result = await this.agent.search(plan.cause, { limit: 10, minRelevance: 1 })
    const portfolio = this.agent.portfolio(all)
    const before = new Set(plan.installments.filter(i => i.status === 'given' || i.status === 'proposed').map(i => i.campaignId))
    const rank = (m: CampaignMatch): number => m.relevance - (plan.preferNew && before.has(m.campaignId) ? 15 : 0)
    const ranked = result.matches
      .filter(m => !m.warnings.some(w => w.includes('instruct AI agents')))
      .map(match => ({ match, campaign: byId.get(match.campaignId)! }))
      .filter(x => x.campaign !== undefined && screen(x.campaign, this.agent.mandate, creatorRecord(all, x.campaign.meta.creatorIdentityKey, x.campaign.id), portfolio, now, { repeat: true, ignoreKeywords: true }).ok)
      .sort((a, b) => rank(b.match) - rank(a.match))
    const checked: Candidate[] = []
    for (const x of ranked) {
      if (checked.length === 3) break
      const d = [await checkAnchor(x.campaign, this.agent.deps), await checkArbiter(x.campaign, this.agent.deps)]
      if (d.every(c => c.ok)) checked.push(x)
      else this.log(`plan ${plan.id}: "${x.campaign.meta.title}" failed due diligence: ${d.filter(c => !c.ok).map(c => c.detail).join('; ')}`)
    }
    return checked
  }

  private async run (plan: GivingPlan, inst: Installment): Promise<GivingPlan> {
    const options = await this.candidates(plan)
    const best = options[0]
    if (best !== undefined && best.match.relevance >= plan.goodMatch) return await this.give(plan, inst, best, `${best.match.relevance}% match`)
    if (best !== undefined && best.match.relevance >= plan.minMatch) {
      if (plan.onWeakMatch === 'closest') return await this.give(plan, inst, best, `closest match (${best.match.relevance}%)`)
      if (plan.onWeakMatch === 'skip') return await this.skip(plan, inst, `only a ${best.match.relevance}% match for "${plan.cause}"`)
      return await this.ask(plan, inst, options, `No campaign fits "${plan.cause}" well right now; the closest is a ${best.match.relevance}% match.`)
    }
    if (options.length === 0) return await this.skip(plan, inst, `no open campaign about "${plan.cause}" passes your terms`)
    if (plan.onWeakMatch === 'skip') return await this.skip(plan, inst, `nothing similar to "${plan.cause}"`)
    return await this.ask(plan, inst, options, `Nothing open is similar to "${plan.cause}".`)
  }

  /** Amount for this installment: the plan's, capped by the budget left and the per-creator cap, in whole 100 sats. */
  private async amountFor (plan: GivingPlan, c: CampaignView): Promise<number> {
    const m = this.agent.mandate
    const portfolio = this.agent.portfolio(await this.agent.deps.api.campaigns())
    const creatorCap = Math.floor(m.budget.totalSats * m.budget.perCreatorMaxPct / 100) - (portfolio.byCreator[c.meta.creatorIdentityKey] ?? 0)
    const raw = Math.min(plan.amountSats, m.budget.totalSats - portfolio.total, creatorCap)
    return Math.floor(raw / 100) * 100
  }

  private patch (plan: GivingPlan, n: number, p: Partial<Installment>): GivingPlan {
    return this.save({ ...plan, installments: plan.installments.map(i => i.n === n ? { ...i, ...p } : i) })
  }

  private async give (plan: GivingPlan, inst: Installment, x: Candidate, why: string): Promise<GivingPlan> {
    const c = x.campaign
    const amount = await this.amountFor(plan, c)
    const label = `installment ${inst.n}/${plan.occurrences} of "${plan.cause}"`
    const base = { campaignId: c.id, campaignTitle: c.meta.title, relevance: x.match.relevance }
    if (amount < MIN_PLEDGE) {
      plan = this.patch(plan, inst.n, { ...base, status: 'skipped', note: 'budget or per-creator limit reached' })
      plan = this.save({ ...plan, status: 'paused' })
      await this.say({ kind: 'info', status: 'info', planId: plan.id, installment: inst.n, text: `Paused your giving plan "${plan.cause}": your budget or per-creator limit is used up. Top up or raise the limit, then resume it.` })
      return plan
    }
    const now = this.now()
    const memoBase = { ...base, kind: 'pledge' as const, checks: [], reasons: [why, x.match.why], amount, planId: plan.id, installment: inst.n }
    if (this.agent.mandate.mode === 'copilot') {
      const memo = this.agent.deps.memos.add({ ...memoBase, status: 'proposed', summary: `${label}: ${x.match.summary} Proposed ${fmt(amount)} sats.` }, now)
      await this.say({ kind: 'info', status: 'info', planId: plan.id, installment: inst.n, text: `For ${label} I propose ${fmt(amount)} sats to "${c.meta.title}" (${why}). Approve it on your donor agent page.` })
      return this.patch(plan, inst.n, { ...base, status: 'proposed', amount, memoId: memo.id, note: why })
    }
    try {
      const pledge = await this.agent.deps.client!.donate(c.meta, amount, this.agent.mandate.memo ?? {})
      const memo = this.agent.deps.memos.add({ ...memoBase, status: 'executed', pledgeId: pledge.id, txid: pledge.id.split('.')[0], summary: `${label}: ${x.match.summary} Gave ${fmt(amount)} sats.` }, now)
      await this.say({ kind: 'info', status: 'info', planId: plan.id, installment: inst.n, text: `Gave ${fmt(amount)} sats to "${c.meta.title}" for ${label} (${why}).` })
      return this.patch(plan, inst.n, { ...base, status: 'given', amount, memoId: memo.id, note: why })
    } catch (e) {
      const error = (e as Error).message
      this.agent.deps.memos.add({ ...memoBase, status: 'failed', summary: `${label}: the pledge failed.`, error }, now)
      await this.say({ kind: 'info', status: 'info', planId: plan.id, installment: inst.n, text: `Could not give to "${c.meta.title}" for ${label}: ${error}` })
      return this.patch(plan, inst.n, { ...base, status: 'failed', note: error })
    }
  }

  private async skip (plan: GivingPlan, inst: Installment, why: string): Promise<GivingPlan> {
    await this.say({ kind: 'info', status: 'info', planId: plan.id, installment: inst.n, text: `Skipped installment ${inst.n}/${plan.occurrences} of "${plan.cause}": ${why}. The sats stay in your budget.` })
    return this.patch(plan, inst.n, { status: 'skipped', note: why })
  }

  private async ask (plan: GivingPlan, inst: Installment, options: Candidate[], why: string): Promise<GivingPlan> {
    const opts: Option[] = options.map(o => ({ campaignId: o.campaign.id, title: o.campaign.meta.title, relevance: o.match.relevance, summary: o.match.summary }))
    const q = await this.say({
      kind: 'question',
      status: 'open',
      planId: plan.id,
      installment: inst.n,
      expiresAt: this.now() + plan.askTimeoutHours * 3_600,
      options: opts,
      text: `${why} Where should installment ${inst.n}/${plan.occurrences} (${fmt(plan.amountSats)} sats) go? ` +
        opts.map((o, i) => `${i + 1}) ${o.title} (${o.relevance}% match)`).join(' ') + ' Or skip this one.'
    })
    return this.patch(plan, inst.n, { status: 'asked', questionId: q.id })
  }

  /** A campaign still open and within the donor's rules (re-checked when an answer or timeout comes later). */
  private async stillEligible (plan: GivingPlan, campaignId: string): Promise<Candidate | undefined> {
    const all = await this.agent.deps.api.campaigns()
    const c = all.find(x => x.id === campaignId)
    if (c === undefined) return undefined
    const ok = screen(c, this.agent.mandate, creatorRecord(all, c.meta.creatorIdentityKey, c.id), this.agent.portfolio(all), this.now(), { repeat: true, ignoreKeywords: true }).ok &&
      (await checkAnchor(c, this.agent.deps)).ok && (await checkArbiter(c, this.agent.deps)).ok
    if (!ok) return undefined
    const match = (await this.agent.search(plan.cause, { limit: 20, minRelevance: 0 })).matches.find(m => m.campaignId === campaignId)
    return { campaign: c, match: match ?? { campaignId, title: c.meta.title, relevance: 0, why: 'your choice', summary: '', facts: {} as CampaignMatch['facts'], warnings: [] } }
  }

  /** The donor answered a question: a campaign id from its options, or 'skip'. */
  async answer (messageId: string, choice: string): Promise<Installment> {
    const q = this.deps.inbox.get(messageId)
    if (q?.kind !== 'question') throw new Error('not a question')
    if (q.status !== 'open') throw new Error(`this question is ${q.status}`)
    if (choice !== 'skip' && !(q.options ?? []).some(o => o.campaignId === choice)) throw new Error('answer with one of the offered campaigns, or "skip"')
    const plan = this.get(q.planId ?? '')
    const inst = plan?.installments.find(i => i.n === q.installment)
    if (plan === undefined || inst?.status !== 'asked') throw new Error('that installment is no longer waiting for you')
    this.deps.inbox.update(q.id, { status: 'answered', answer: choice })
    let after: GivingPlan
    if (choice === 'skip') {
      after = await this.skip(plan, inst, 'you said skip')
    } else {
      const c = await this.stillEligible(plan, choice)
      after = c === undefined
        ? await this.skip(plan, inst, 'the campaign you chose is no longer open or no longer passes your terms')
        : await this.give(plan, inst, c, 'your choice')
    }
    return after.installments[inst.n - 1]
  }
}

// ── plain-language plans ────────────────────────────────────────────────────

export interface PlanParser {
  readonly name: string
  /** A draft for the donor to confirm; never saved by itself. */
  parse: (text: string) => Promise<GivingPlanInput>
}

const PERIOD_DAYS = { day: 1, week: 7, month: 30.4375, year: 365.25 } as const
type Period = keyof typeof PERIOD_DAYS

/** Offline parser: amount in sats, cadence, duration, and what to do when nothing fits. */
export class MockPlanParser implements PlanParser {
  readonly name = 'mock'

  async parse (text: string): Promise<GivingPlanInput> {
    let rest = ` ${text.trim()} `
    const take = (re: RegExp): RegExpMatchArray | null => { const m = rest.match(re); if (m !== null) rest = rest.replace(m[0], ' '); return m }

    const amount = take(/(\d[\d,.' ]*)\s*(k)?\s*(sats?|satoshis?)\b/i)
    if (amount === null) throw new Error('say how many sats per installment, e.g. "5000 sats"')
    const amountSats = Math.round(Number(amount[1].replace(/[,.' ]/g, '')) * (amount[2] !== undefined ? 1000 : 1))

    const cad = take(/\b(?:every|each|per|a|once a)\s+(day|week|month)\b|\b(daily|weekly|monthly)\b/i)
    const unit = (cad?.[1] ?? cad?.[2] ?? 'month').toLowerCase()
    const cadence: Cadence = unit.startsWith('da') ? 'daily' : unit.startsWith('week') ? 'weekly' : 'monthly'

    let occurrences = cadence === 'monthly' ? 12 : cadence === 'weekly' ? 52 : 30
    const times = take(/\b(\d+)\s+times\b/i)
    const span = times === null ? take(/\bfor\s+(a|an|one|two|three|six|\d+)\s+(days?|weeks?|months?|years?)\b/i) : null
    if (times !== null) occurrences = Number(times[1])
    else if (span !== null) {
      const words: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, six: 6 }
      const n = words[span[1].toLowerCase()] ?? Number(span[1])
      const days = n * PERIOD_DAYS[span[2].toLowerCase().replace(/s$/, '') as Period]
      occurrences = Math.max(1, Math.round(days / PERIOD_DAYS[CADENCE_WORD[cadence] as Period]))
    }

    let onWeakMatch: WeakMatch = 'ask'
    while (take(/\b(on (its|your) own|automatically|without asking|(don'?t|do not) ask( me)?|(the )?(closest|most similar)( one| match| campaign)?)\b/i) !== null) onWeakMatch = 'closest'
    while (take(/\b(ask me|message me|check with me|send me a message)( first)?\b/i) !== null);
    while (take(/\b(if|when) (nothing|none|no campaign|there is nothing)( fits| matches| is available| exactly)?\b/i) !== null);

    const cause = rest
      .replace(/\b(i want to|i'd like to|i would like to|please|donate|give|send|pay|choose|pick|select|to (a )?campaigns? (that|which)( does| do| is| are)?|campaigns?|otherwise|else|and|then|for|to|of)\b/gi, ' ')
      .replace(/[,.;:!?]+/g, ' ').replace(/\s+/g, ' ').trim()
    if (cause === '') throw new Error('say what to support, e.g. "children in need"')
    return { cause, amountSats, cadence, occurrences, onWeakMatch, text: text.trim() }
  }
}

const PlanSchema = z.object({
  cause: z.string(),
  amountSats: z.number(),
  cadence: z.enum(['daily', 'weekly', 'monthly']),
  occurrences: z.number(),
  onWeakMatch: z.enum(['ask', 'closest', 'skip'])
})

export class ClaudePlanParser implements PlanParser {
  readonly name: string
  private readonly client: Anthropic

  constructor (readonly model = process.env.DONOR_MODEL ?? 'claude-opus-5-5', client?: Anthropic) {
    this.client = client ?? new Anthropic()
    this.name = `claude:${model}`
  }

  async parse (text: string): Promise<GivingPlanInput> {
    const response = await this.client.beta.messages.parse({
      model: this.model,
      max_tokens: 4000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low', format: betaZodOutputFormat(PlanSchema) },
      system: 'Turn a donor\'s description of a recurring donation into a plan. cause: a few search words for what to support. amountSats: satoshis per ' +
        'installment (only if the donor gave an amount in sats; otherwise 0). cadence and occurrences: e.g. "every month for a year" = monthly, 12. ' +
        'onWeakMatch: "ask" if the donor wants to be asked when nothing fits (the default), "closest" if they want the agent to pick the most similar ' +
        'campaign on its own, "skip" if they want that installment skipped.',
      messages: [{ role: 'user', content: text }]
    })
    if (response.stop_reason === 'refusal') throw new Error('the model declined this request')
    const out = response.parsed_output
    if (out == null) throw new Error(`no structured output (stop_reason: ${response.stop_reason})`)
    if (!Number.isSafeInteger(out.amountSats) || out.amountSats <= 0) throw new Error('say how many sats per installment, e.g. "5000 sats"')
    return { ...out, occurrences: Math.round(out.occurrences), text: text.trim() }
  }
}

export function defaultPlanParser (): PlanParser {
  const hasKey = (process.env.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_AUTH_TOKEN ?? '') !== ''
  return hasKey && process.env.DONOR_BRAIN !== 'mock' ? new ClaudePlanParser() : new MockPlanParser()
}
