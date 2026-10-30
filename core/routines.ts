/**
 * Giving routines: "donate 10 euros to an animal shelter every month".
 *
 * A routine is a standing instruction the user gives the giving agent in plain
 * language. This module is shared by the browser app and the server, so both
 * apply exactly the same rules. It is pure (no I/O): parsing, scheduling,
 * campaign matching and the spending limits.
 *
 * Trust model (see docs/AGENT_ROUTINES_NOTES.md):
 *  - The agent never holds keys or money. A routine only says WHEN and HOW MUCH
 *    the user wants to give; every execution is a normal pledge into a campaign's
 *    sCrypt escrow, created by the user's own wallet after the user approves it.
 *  - Limits are fixed when the routine is created (`maxSatsPerRun`, optional
 *    `maxRuns` / `maxTotalSats`). The app refuses to propose more, and the server
 *    refuses to record a run that breaks them.
 *  - Owners are an `OwnerRef`, not a bare identity key, so a zero-knowledge
 *    identity (x-zk-proof header, snarkjs/Groth16 branch) can own routines later
 *    without changing the data model.
 */
import type { CampaignMeta, CampaignStatus } from './campaign'
import { MIN_PLEDGE } from './pledge'

// ─────────────────────────────── data model ───────────────────────────────

export type RoutineInterval = 'once' | 'daily' | 'weekly' | 'monthly' | 'yearly'
export const ROUTINE_INTERVALS: readonly RoutineInterval[] = ['once', 'daily', 'weekly', 'monthly', 'yearly']

/** Fiat amounts are converted to satoshis at execution time; 'SATS' is exact. */
export type RoutineCurrency = 'EUR' | 'USD' | 'SATS'
export const ROUTINE_CURRENCIES: readonly RoutineCurrency[] = ['EUR', 'USD', 'SATS']

/**
 * active    → executes when due
 * paused    → kept, skipped until resumed
 * completed → ran its last time (one-off, maxRuns or maxTotalSats reached); final
 * cancelled → stopped by the user; final
 */
export type RoutineStatus = 'active' | 'paused' | 'completed' | 'cancelled'

/**
 * Who owns a routine. Today: the BRC-103 identity key the server verified
 * (AuthFetch). Later: a ZK identity commitment proven with an `x-zk-proof`
 * header, so the server learns that the caller is a registered user without
 * learning which identity key it is. Storage and checks only ever use
 * `ownerKey(owner)`, so adding a scheme does not touch them.
 */
export type OwnerRef =
  | { scheme: 'brc103', identityKey: string }
  | { scheme: 'zk', commitment: string }

export const ownerKey = (o: OwnerRef): string => o.scheme === 'brc103' ? `brc103:${o.identityKey}` : `zk:${o.commitment}`

export interface RoutineAmount { value: number, currency: RoutineCurrency }

/** What the routine gives to. Keywords pick a matching campaign at each run, unless one is pinned. */
export interface RoutineTarget {
  /** The user's own words, e.g. "an animal shelter". */
  label: string
  /** Lower-case search terms matched against campaign titles and descriptions. */
  keywords: string[]
  /** Optional: always give to this campaign (id = sha256 of its meta). */
  campaignId?: string
}

/** Hard ceilings, fixed when the routine is created and enforced on both sides. */
export interface RoutineLimits {
  /** Never pledge more than this per run, whatever the exchange rate does. */
  maxSatsPerRun: number
  /** Stop after this many runs (null = until cancelled). */
  maxRuns: number | null
  /** Stop once this many satoshis were given in total (null = no total cap). */
  maxTotalSats: number | null
}

/** A routine before it is saved: the result of interpreting the user's message. */
export interface RoutineDraft {
  /** The instruction as the user typed it (kept for transparency). */
  text: string
  amount: RoutineAmount
  interval: RoutineInterval
  target: RoutineTarget
  limits: RoutineLimits
}

/** One execution: a pledge the user's wallet made into a campaign's escrow. */
export interface RoutineRun {
  at: number
  campaignId: string
  campaignTitle: string
  sats: number
  /** Outpoint `txid.vout` of the escrow pledge (the on-chain proof of the run). */
  pledgeId: string
  /** Offline demo only: no transaction was made. */
  simulated?: boolean
}

export interface Routine extends RoutineDraft {
  id: string
  owner: OwnerRef
  status: RoutineStatus
  createdAt: number
  /** Unix seconds when the next run is due; null once the routine is final. */
  nextRunAt: number | null
  runs: RoutineRun[]
}

export const ROUTINE_LIMITS = { text: 280, label: 80, keywords: 16, keyword: 32, maxSatsPerRun: 10_000_000_000 } as const

// ───────────────────────────── interpretation ─────────────────────────────

export type ParseResult =
  | { ok: true, draft: Omit<RoutineDraft, 'limits'> & { limits: Omit<RoutineLimits, 'maxSatsPerRun'> }, lang: 'de' | 'en' }
  | { ok: false, error: string, lang: 'de' | 'en' }

const CURRENCY_WORDS: Array<[RegExp, RoutineCurrency | 'BSV']> = [
  [/^(€|eur|euro|euros)$/, 'EUR'],
  [/^(\$|usd|dollar|dollars|dollar)$/, 'USD'],
  [/^(sat|sats|satoshi|satoshis)$/, 'SATS'],
  [/^bsv$/, 'BSV']
]

const INTERVAL_PATTERNS: Array<[RegExp, RoutineInterval]> = [
  [/\b(jeden|jede|jedes|pro|every|each|per|a|im)\s+(monat|month)\b|\bmonatlich\b|\bmonthly\b/, 'monthly'],
  [/\b(jede|jeden|pro|every|each|per|a|in der)\s+(woche|week)\b|\bwöchentlich\b|\bwoechentlich\b|\bweekly\b/, 'weekly'],
  [/\b(jeden|jede|pro|every|each|per|a)\s+(tag|day)\b|\btäglich\b|\btaeglich\b|\bdaily\b/, 'daily'],
  [/\b(jedes|jede|pro|every|each|per|a|im)\s+(jahr|year)\b|\bjährlich\b|\bjaehrlich\b|\byearly\b|\bannually\b/, 'yearly'],
  [/\beinmal(ig)?\b|\bonce\b|\bone[- ]off\b|\bone[- ]time\b/, 'once']
]

/**
 * Topics people name in plain words, mapped to the terms campaigns actually use.
 * Matching is a simple keyword search, so broad synonyms make "Tierschutzverein"
 * find an "elephant tracking" campaign.
 */
const TOPICS: Array<{ match: RegExp, keywords: string[] }> = [
  { match: /tier|animal|hund|katze|dog|cat|wildlife|wildtier|shelter|zoo|elefant|elephant|vogel|bird/, keywords: ['animal', 'animals', 'wildlife', 'shelter', 'pet', 'dog', 'cat', 'elephant', 'bird', 'tier', 'tierschutz'] },
  { match: /umwelt|klima|environment|climate|baum|bäume|tree|wald|forest|fluss|river|meer|ocean|plastik|plastic/, keywords: ['environment', 'climate', 'tree', 'trees', 'forest', 'river', 'ocean', 'plastic', 'cleanup', 'umwelt', 'klima'] },
  { match: /luft|air|smog|pollution|verschmutzung/, keywords: ['air', 'quality', 'pollution', 'aqi', 'smog', 'luft'] },
  { match: /kind|kinder|child|children|schule|school|bildung|education|lesen|literacy|book|buch/, keywords: ['children', 'child', 'school', 'education', 'literacy', 'book', 'books', 'kinder', 'bildung'] },
  { match: /gesundheit|health|medizin|medical|klinik|clinic|malaria|krankenhaus|hospital/, keywords: ['health', 'medical', 'clinic', 'malaria', 'hospital', 'medicine', 'gesundheit'] },
  { match: /hunger|essen|food|tafel|lebensmittel|meal/, keywords: ['food', 'hunger', 'meal', 'meals', 'food bank', 'tafel'] },
  { match: /katastrophe|disaster|flut|flood|erdbeben|earthquake|notfall|emergency/, keywords: ['disaster', 'flood', 'earthquake', 'emergency', 'relief', 'katastrophe'] },
  { match: /recht|legal|anwalt|lawyer|mieter|tenant/, keywords: ['legal', 'law', 'tenant', 'court', 'rights'] },
  { match: /wissenschaft|science|forschung|research|studie|study|open source|software/, keywords: ['science', 'research', 'study', 'open', 'data', 'software'] }
]

const STOPWORDS = new Set([
  'einen', 'einem', 'einer', 'eine', 'ein', 'den', 'dem', 'der', 'die', 'das', 'des', 'und', 'oder', 'für', 'fuer', 'mit', 'von', 'zum', 'zur', 'bitte', 'spende', 'spenden',
  'the', 'and', 'for', 'with', 'from', 'some', 'any', 'please', 'donate', 'give', 'that', 'this', 'which', 'local', 'lokalen', 'lokale', 'verein', 'organisation', 'organization', 'charity', 'ngo'
])

// Words that only appear in German instructions ("an" and "mal" are English too, so they are not hints).
const GERMAN_HINT = /\b(spende|spenden|jeden|jede|jedes|monat|woche|tag|jahr|monatlich|wöchentlich|täglich|einmalig|für|einen|eine|verein|bitte)\b/

const num = (s: string): number => Number(s.replace(/\s/g, '').replace(',', '.'))

/**
 * Turn a message such as "Spende jeden Monat 10 Euro an einen Tierschutzverein"
 * into a routine draft. Deterministic and offline: the server may use an LLM to
 * interpret harder phrasings, but its output goes through `validateDraft` too.
 *
 * Returns ok:false with a short question when something essential (the amount
 * or the cause) is missing. The caller adds the per-run cap (it needs a price).
 */
export function parseRoutineText (input: string): ParseResult {
  const text = input.trim().slice(0, ROUTINE_LIMITS.text)
  const lower = ` ${text.toLowerCase()} `
  const lang: 'de' | 'en' = GERMAN_HINT.test(lower) ? 'de' : 'en'
  const ask = (de: string, en: string): ParseResult => ({ ok: false, error: lang === 'de' ? de : en, lang })

  // Amount: "10 euro", "10€", "€10", "2,50 EUR", "5000 sats", "0.001 bsv".
  let amount: RoutineAmount | undefined
  let rest = lower
  const after = /(\d+(?:[.,]\d+)?)\s*(€|\$|[a-zäöü]+)/g
  for (const m of lower.matchAll(after)) {
    const cur = CURRENCY_WORDS.find(([re]) => re.test(m[2]))?.[1]
    if (cur === undefined) continue
    amount = cur === 'BSV' ? { value: Math.round(num(m[1]) * 100_000_000), currency: 'SATS' } : { value: num(m[1]), currency: cur }
    rest = rest.replace(m[0], ' ')
    break
  }
  if (amount === undefined) {
    const before = /(€|\$)\s*(\d+(?:[.,]\d+)?)/.exec(lower)
    if (before !== null) {
      amount = { value: num(before[2]), currency: before[1] === '€' ? 'EUR' : 'USD' }
      rest = rest.replace(before[0], ' ')
    }
  }
  if (amount === undefined || !Number.isFinite(amount.value) || amount.value <= 0) {
    return ask('Wie viel möchtest du spenden? Zum Beispiel „10 Euro“ oder „5000 sats“.', 'How much would you like to give? For example "10 euros" or "5000 sats".')
  }
  if (amount.currency === 'SATS') amount.value = Math.round(amount.value)

  // Interval; one-off when none is named.
  let interval: RoutineInterval = 'once'
  for (const [re, iv] of INTERVAL_PATTERNS) {
    const m = re.exec(rest)
    if (m !== null) { interval = iv; rest = rest.replace(m[0], ' '); break }
  }

  // Optional run count: "für 6 Monate", "for 3 months", "6 mal", "12 times".
  let maxRuns: number | null = interval === 'once' ? 1 : null
  const count = /\b(?:für|fuer|for)\s+(\d{1,3})\s+(?:monate|months|wochen|weeks|tage|days|jahre|years)\b|\b(\d{1,3})\s*(?:mal|times)\b/.exec(rest)
  if (count !== null && interval !== 'once') {
    maxRuns = Number(count[1] ?? count[2])
    rest = rest.replace(count[0], ' ')
  }

  // Cause: what follows "an"/"to" (or "für"/"for"), minus filler words.
  const cause = /\s(?:an|to|für|fuer|for|towards)\s+(.+)$/.exec(rest.replace(/\s+/g, ' '))
  const found = (cause?.[1] ?? '')
    .replace(/^(?:(?:einen|eine|ein|einem|einer|den|die|das|dem|der|a|an|the|some)\s+)+/, '')
    .replace(/[.!?,;:]+\s*$/, '')
    .trim()
  // Show the cause in the user's own spelling ("Tierschutzverein", not "tierschutzverein").
  const at = text.toLowerCase().indexOf(found)
  const label = (at >= 0 && found !== '' ? text.slice(at, at + found.length) : found).slice(0, ROUTINE_LIMITS.label)
  if (label === '') {
    return ask('An wen soll die Spende gehen? Zum Beispiel „an einen Tierschutzverein“.', 'Who should receive it? For example "to an animal shelter".')
  }

  return { ok: true, lang, draft: { text, amount, interval, target: { label, keywords: keywordsFor(label) }, limits: { maxRuns, maxTotalSats: null } } }
}

/** Search terms for a cause: its own meaningful words plus the synonyms of every topic it mentions. */
export function keywordsFor (label: string): string[] {
  const lower = label.toLowerCase()
  const own = lower.split(/[^a-zäöüß0-9]+/).filter(w => w.length >= 3 && !STOPWORDS.has(w))
  const topical = TOPICS.filter(t => t.match.test(lower)).flatMap(t => t.keywords)
  return [...new Set([...own, ...topical])].slice(0, ROUTINE_LIMITS.keywords)
}

// ──────────────────────────────── validation ────────────────────────────────

const isPosInt = (n: unknown, max = Number.MAX_SAFE_INTEGER): n is number => Number.isSafeInteger(n) && (n as number) > 0 && (n as number) <= max

/**
 * Check a draft that came from outside (the browser, or an LLM). Throws a
 * readable Error. The server calls this before storing anything.
 */
export function validateDraft (d: RoutineDraft): RoutineDraft {
  const fail = (m: string): never => { throw new Error(m) }
  if (d === null || typeof d !== 'object') fail('routine draft missing')
  if (typeof d.text !== 'string' || d.text.trim() === '' || d.text.length > ROUTINE_LIMITS.text) fail(`text must be 1–${ROUTINE_LIMITS.text} characters`)
  if (!ROUTINE_CURRENCIES.includes(d.amount?.currency)) fail('unknown currency')
  if (!(typeof d.amount.value === 'number' && Number.isFinite(d.amount.value) && d.amount.value > 0)) fail('amount must be positive')
  if (d.amount.currency === 'SATS' && !isPosInt(d.amount.value)) fail('a satoshi amount must be a whole number')
  if (!ROUTINE_INTERVALS.includes(d.interval)) fail('unknown interval')
  const t = d.target
  if (typeof t?.label !== 'string' || t.label.trim() === '' || t.label.length > ROUTINE_LIMITS.label) fail(`target label must be 1–${ROUTINE_LIMITS.label} characters`)
  if (!Array.isArray(t.keywords) || t.keywords.length > ROUTINE_LIMITS.keywords || t.keywords.some(k => typeof k !== 'string' || k === '' || k.length > ROUTINE_LIMITS.keyword)) fail('invalid keywords')
  if (t.campaignId !== undefined && !/^[0-9a-f]{64}$/.test(t.campaignId)) fail('campaignId must be 32 bytes hex')
  if (t.keywords.length === 0 && t.campaignId === undefined) fail('a routine needs keywords or a campaign')
  const l = d.limits
  if (!isPosInt(l?.maxSatsPerRun, ROUTINE_LIMITS.maxSatsPerRun) || l.maxSatsPerRun < MIN_PLEDGE) fail(`maxSatsPerRun must be at least ${MIN_PLEDGE} sats`)
  if (l.maxRuns !== null && !isPosInt(l.maxRuns, 1000)) fail('maxRuns must be 1–1000 or null')
  if (d.interval === 'once' && l.maxRuns !== 1) fail('a one-off routine runs exactly once')
  if (l.maxTotalSats !== null && (!isPosInt(l.maxTotalSats) || l.maxTotalSats < l.maxSatsPerRun)) fail('maxTotalSats must be at least maxSatsPerRun')
  if (d.amount.currency === 'SATS' && d.amount.value > l.maxSatsPerRun) fail('the amount is above the per-run cap')
  return {
    text: d.text.trim(),
    amount: { value: d.amount.value, currency: d.amount.currency },
    interval: d.interval,
    target: { label: t.label.trim(), keywords: t.keywords.map(k => k.toLowerCase()), ...(t.campaignId !== undefined ? { campaignId: t.campaignId } : {}) },
    limits: { maxSatsPerRun: l.maxSatsPerRun, maxRuns: l.maxRuns, maxTotalSats: l.maxTotalSats }
  }
}

/** A fresh routine. Its first run is due immediately. */
export function newRoutine (id: string, owner: OwnerRef, draft: RoutineDraft, now: number): Routine {
  return { ...validateDraft(draft), id, owner, status: 'active', createdAt: now, nextRunAt: now, runs: [] }
}

// ──────────────────────────────── scheduling ────────────────────────────────

/** When the run after one at `from` (unix seconds) is due. Calendar months/years in UTC. */
export function nextRunAfter (interval: RoutineInterval, from: number): number | null {
  const d = new Date(from * 1000)
  switch (interval) {
    case 'once': return null
    case 'daily': return from + 86_400
    case 'weekly': return from + 7 * 86_400
    case 'monthly': d.setUTCMonth(d.getUTCMonth() + 1); return Math.floor(d.getTime() / 1000)
    case 'yearly': d.setUTCFullYear(d.getUTCFullYear() + 1); return Math.floor(d.getTime() / 1000)
  }
}

export const totalGiven = (r: Routine): number => r.runs.reduce((s, x) => s + x.sats, 0)

export const isDue = (r: Routine, now: number): boolean => r.status === 'active' && r.nextRunAt !== null && r.nextRunAt <= now

/** Satoshis for the routine's amount at `bsvPrice` (fiat per 1 BSV). */
export function satsFor (amount: RoutineAmount, bsvPrice?: number): number {
  if (amount.currency === 'SATS') return amount.value
  if (bsvPrice === undefined || !(bsvPrice > 0)) throw new Error(`no ${amount.currency}/BSV exchange rate available`)
  return Math.round((amount.value / bsvPrice) * 100_000_000)
}

/**
 * The limits check for one run. Throws why a run of `sats` is not allowed now.
 * Used by the app before it asks the wallet, and by the server before it records.
 */
export function checkRun (r: Routine, sats: number, now: number): void {
  if (r.status !== 'active') throw new Error(`routine is ${r.status}`)
  if (!isDue(r, now)) throw new Error(`routine is not due until ${new Date((r.nextRunAt ?? 0) * 1000).toISOString()}`)
  if (!Number.isSafeInteger(sats) || sats < MIN_PLEDGE) throw new Error(`a run must give at least ${MIN_PLEDGE} sats`)
  if (sats > r.limits.maxSatsPerRun) throw new Error(`${sats} sats is above this routine's cap of ${r.limits.maxSatsPerRun} sats per run (the exchange rate moved; raise the cap or wait)`)
  if (r.limits.maxTotalSats !== null && totalGiven(r) + sats > r.limits.maxTotalSats) throw new Error(`this run would exceed the routine's total cap of ${r.limits.maxTotalSats} sats`)
  if (r.limits.maxRuns !== null && r.runs.length >= r.limits.maxRuns) throw new Error('routine already made all its runs')
}

/** Record a run (after `checkRun`) and advance the schedule. Returns a new object. */
export function applyRun (r: Routine, run: RoutineRun): Routine {
  const runs = [...r.runs, run]
  const total = runs.reduce((s, x) => s + x.sats, 0)
  // Next due date counts from the scheduled time, not from when the user got
  // round to approving, so a monthly routine stays on its day of the month.
  const next = nextRunAfter(r.interval, Math.max(r.nextRunAt ?? run.at, r.createdAt))
  const done = next === null ||
    (r.limits.maxRuns !== null && runs.length >= r.limits.maxRuns) ||
    (r.limits.maxTotalSats !== null && total + MIN_PLEDGE > r.limits.maxTotalSats)
  return { ...r, runs, status: done ? 'completed' : r.status, nextRunAt: done ? null : next }
}

/** Status changes a user may make. Final states stay final. */
export function canSetStatus (from: RoutineStatus, to: RoutineStatus): boolean {
  if (from === 'completed' || from === 'cancelled') return false
  return (to === 'active' || to === 'paused' || to === 'cancelled') && to !== from
}

// ──────────────────────────────── matching ────────────────────────────────

export interface CampaignLike { id: string, meta: Pick<CampaignMeta, 'title' | 'description' | 'deadline'>, status: CampaignStatus }

/**
 * Campaigns a run may give to, best match first: open for pledges (status
 * 'active', deadline not passed) and either the pinned campaign or one whose
 * title/description contains the routine's keywords (title hits weigh more).
 */
export function matchCampaigns<C extends CampaignLike> (target: RoutineTarget, campaigns: C[], now: number): Array<{ campaign: C, score: number }> {
  const open = campaigns.filter(c => c.status === 'active' && c.meta.deadline > now)
  if (target.campaignId !== undefined) return open.filter(c => c.id === target.campaignId).map(campaign => ({ campaign, score: 100 }))
  return open
    .map(campaign => {
      const title = campaign.meta.title.toLowerCase()
      const body = campaign.meta.description.toLowerCase()
      const score = target.keywords.reduce((s, k) => s + (title.includes(k) ? 3 : 0) + (body.includes(k) ? 1 : 0), 0)
      return { campaign, score }
    })
    .filter(m => m.score > 0)
    .sort((a, b) => b.score - a.score)
}

/**
 * Whether a campaign fits the routine's target at all (ignores whether it is
 * still open). The server uses it to check that a reported run went to a
 * campaign the routine allows, not to any campaign the client liked.
 */
export function matchesTarget (target: RoutineTarget, campaignId: string, meta: Pick<CampaignMeta, 'title' | 'description'>): boolean {
  if (target.campaignId !== undefined) return target.campaignId === campaignId
  const text = `${meta.title}\n${meta.description}`.toLowerCase()
  return target.keywords.some(k => text.includes(k))
}

// ──────────────────────────────── wording ────────────────────────────────

// Locale-formatted like the rest of the app (formatSats), so "5.000 sats" and "5,000 sats" never sit side by side.
const AMOUNT_TEXT = (a: RoutineAmount): string => a.currency === 'SATS' ? `${a.value.toLocaleString()} sats` : `${a.value.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${a.currency === 'EUR' ? '€' : '$'}`

const INTERVAL_TEXT: Record<'de' | 'en', Record<RoutineInterval, string>> = {
  de: { once: 'einmalig', daily: 'jeden Tag', weekly: 'jede Woche', monthly: 'jeden Monat', yearly: 'jedes Jahr' },
  en: { once: 'once', daily: 'every day', weekly: 'every week', monthly: 'every month', yearly: 'every year' }
}

export const intervalText = (i: RoutineInterval, lang: 'de' | 'en' = 'en'): string => INTERVAL_TEXT[lang][i]
export const amountText = AMOUNT_TEXT

/** One sentence the agent says back, so the user can check it understood. */
export function describeDraft (d: Pick<RoutineDraft, 'amount' | 'interval' | 'target' | 'limits'>, lang: 'de' | 'en'): string {
  const runs = d.limits.maxRuns !== null && d.interval !== 'once' ? (lang === 'de' ? `, ${d.limits.maxRuns}-mal` : `, ${d.limits.maxRuns} times`) : ''
  return lang === 'de'
    ? `Verstanden: ${AMOUNT_TEXT(d.amount)} ${INTERVAL_TEXT.de[d.interval]}${runs} an „${d.target.label}“.`
    : `Got it: ${AMOUNT_TEXT(d.amount)} ${INTERVAL_TEXT.en[d.interval]}${runs} to "${d.target.label}".`
}
