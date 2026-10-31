/**
 * "Giving routines" (#/routines): tell the giving agent in plain words what to
 * give, e.g. "Spende jeden Monat 10 Euro an einen Tierschutzverein", and manage
 * the routines it keeps for you.
 *
 * Flow, and where trust sits:
 *  1. Chat: the message is interpreted (server: Claude or rules; offline demo:
 *     rules in the browser). Nothing is saved yet.
 *  2. Confirm card: the user sees exactly what was understood and sets the hard
 *     cap per run (and optionally how many runs). Only then is it saved.
 *  3. When a routine is due, the page shows which campaign it would go to and
 *     how many sats. "Approve & donate" asks for an in-app confirmation and then
 *     the user's wallet creates a pledge into that campaign's sCrypt escrow.
 *     The agent never signs anything and never holds funds.
 *  4. The run is reported to the server, which checks it against the routine's
 *     limits; every run links to its transaction.
 *
 * Automatic execution (no approval per gift): the user switches a routine to
 * "Automatic", which delegates it to THEIR routine agent (agent/routineAgent.ts,
 * running on their machine with its own wallet and a budget they moved into it).
 * The agent then runs it when due, within the routine's caps and its budget.
 * The user's own keys are still never involved, and "Manual" revokes it at once.
 * In the offline demo a simulated agent does the same with simulated runs.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import type { CampaignView } from '../../../core/api'
import { MIN_PLEDGE } from '../../../core/pledge'
import {
  amountText, describeDraft, intervalText, isAutomatic, isDue, matchCampaigns, totalGiven,
  type ParseResult, type Routine, type RoutineDraft, type RoutineStatus
} from '../../../core/routines'
import { agentApi, RoutineAgentCard, type AgentActivity, type AgentStatus } from '../components/RoutineAgentCard'
import { Notice } from '../components/ui'
import { dateTime, formatSats, short, WOC_TX } from '../format'
import { bsvPrice, DEMO_AGENT_KEY, executeRoutine, LocalRoutineStore, now, planRun, ServerRoutineStore, simulateRoutine, type RoutineStore, type RunPlan } from '../routines'
import { api, confirmSpend, useWallet } from '../wallet'

interface ChatMessage { from: 'user' | 'agent', text: string }

/** A draft waiting for the user's confirmation, with the editable limits. */
interface Pending {
  parsed: Extract<ParseResult, { ok: true }>
  /** Satoshis the amount is worth now (undefined if no exchange rate). */
  estimate?: number
  cap: number
  maxRuns: number | null
  preview?: CampaignView
  /** Delegate to the routine agent right after saving. */
  auto: boolean
}

/** The offline demo's stand-in agent: a fixed simulated budget. */
const DEMO_BUDGET = 1_000_000

const EXAMPLES = [
  'Spende jeden Monat 10 Euro an einen Tierschutzverein',
  'Donate 5000 sats every week to school projects',
  'Give $3 once to open-source education'
]

const STATUS_LABEL: Record<RoutineStatus, string> = { active: 'Active', paused: 'Paused', completed: 'Completed', cancelled: 'Cancelled' }

export function Routines () {
  const { connect, identityKey, serverNetwork, connecting } = useWallet()
  const offline = serverNetwork === 'mock'
  // Offline demo: routines live in this browser. Otherwise: on the server, under the wallet's identity.
  const store: RoutineStore | undefined = useMemo(
    () => offline ? new LocalRoutineStore() : identityKey !== undefined ? new ServerRoutineStore(api) : undefined,
    [offline, identityKey]
  )

  const [chat, setChat] = useState<ChatMessage[]>([{
    from: 'agent',
    text: 'Hi! Tell me what you would like to give, how much and how often, e.g. "Spende jeden Monat 10 Euro an einen Tierschutzverein". ' +
      'Every gift goes into a campaign\'s escrow. You approve each one in your wallet, or let your routine agent run it automatically from a budget you give it.'
  }])
  const [input, setInput] = useState('')
  const [thinking, setThinking] = useState(false)
  const [pending, setPending] = useState<Pending>()
  const [routines, setRoutines] = useState<Routine[]>([])
  const [campaigns, setCampaigns] = useState<CampaignView[]>([])
  const [plans, setPlans] = useState<Record<string, RunPlan | string>>({})
  const [busy, setBusy] = useState<string>()
  const [msg, setMsg] = useState<{ ok: boolean, text: string, txid?: string }>()
  const chatEnd = useRef<HTMLDivElement>(null)
  // undefined = still looking, null = no routine agent reachable.
  const [agent, setAgent] = useState<AgentStatus | null>()
  const [demoActivity, setDemoActivity] = useState<AgentActivity[]>([])

  const say = (from: ChatMessage['from'], text: string) => setChat(c => [...c, { from, text }])

  const load = useCallback(async () => {
    try { setCampaigns(await api.campaigns()) } catch { /* list stays as it was */ }
    if (store === undefined) { setRoutines([]); return }
    try { setRoutines(await store.list()) } catch (e) { setMsg({ ok: false, text: `Could not load your routines: ${(e as Error).message}` }) }
  }, [store])
  useEffect(() => { void load() }, [load])

  // The user's routine agent: polled through the local dev server's /routine-agent proxy; simulated in the offline demo.
  const loadAgent = useCallback(async () => {
    if (serverNetwork === undefined) return
    if (offline) {
      const spent = demoActivity.reduce((sum, a) => sum + (a.sats ?? 0), 0)
      setAgent({ identityKey: DEMO_AGENT_KEY, balance: DEMO_BUDGET - spent, ownerIdentityKey: null, activity: demoActivity, simulated: true })
      return
    }
    try { setAgent(await agentApi<AgentStatus>('/api/routine-agent')) } catch { setAgent(null) }
  }, [offline, serverNetwork, demoActivity])
  useEffect(() => {
    void loadAgent()
    const t = setInterval(() => { void loadAgent(); void load() }, 10_000)
    return () => clearInterval(t)
  }, [loadAgent, load])

  // Offline demo: the simulated agent runs automatic routines as soon as they are due (a real agent checks every minute).
  useEffect(() => {
    if (!offline || store === undefined) return
    const tick = async (): Promise<void> => {
      const todo = (await store.list()).filter(r => isAutomatic(r) && isDue(r, now()))
      if (todo.length === 0) return
      const all = await api.campaigns()
      for (const r of todo) {
        try {
          const plan = await planRun(r, all)
          await simulateRoutine(store, r, plan)
          setDemoActivity(a => [{ at: now(), routineId: r.id, label: r.target.label, kind: 'paid', sats: plan.sats, campaignId: plan.campaign.id, text: `${formatSats(plan.sats)} into the escrow of "${plan.campaign.meta.title}" (simulated)` }, ...a])
        } catch (e) {
          const text = (e as Error).message
          setDemoActivity(a => a[0]?.routineId === r.id && a[0].text === text ? a : [{ at: now(), routineId: r.id, label: r.target.label, kind: 'skipped', text }, ...a])
        }
      }
      await load()
    }
    const t = setInterval(() => { void tick() }, 4_000)
    return () => clearInterval(t)
  }, [offline, store, load])
  useEffect(() => { chatEnd.current?.scrollIntoView({ block: 'nearest' }) }, [chat, pending])

  // For every due MANUAL routine: work out where it would go and how much, so the user sees it before approving.
  useEffect(() => {
    let stale = false
    void (async () => {
      const next: Record<string, RunPlan | string> = {}
      for (const r of routines.filter(r => isDue(r, now()) && !isAutomatic(r))) {
        try { next[r.id] = await planRun(r, campaigns) } catch (e) { next[r.id] = (e as Error).message }
      }
      if (!stale) setPlans(next)
    })()
    return () => { stale = true }
  }, [routines, campaigns])

  /** The store to save into; connects the wallet first when needed. */
  async function ensureStore (): Promise<RoutineStore | undefined> {
    if (store !== undefined) return store
    const client = await connect()
    return client === undefined ? undefined : new ServerRoutineStore(api)
  }

  async function send (e?: FormEvent, text = input) {
    e?.preventDefault()
    const t = text.trim()
    if (t === '' || thinking) return
    say('user', t)
    setInput('')
    setPending(undefined)
    setThinking(true)
    try {
      // Without a connected wallet (and outside the demo) the browser's own parser reads it; saving will connect.
      const { result } = await (store ?? new LocalRoutineStore()).interpret(t)
      if (!result.ok) { say('agent', result.error); return }
      const price = await bsvPrice(result.draft.amount.currency)
      const estimate = result.draft.amount.currency === 'SATS' ? result.draft.amount.value : price !== undefined ? Math.round(result.draft.amount.value / price * 1e8) : undefined
      // Default cap: the amount now plus 50% headroom for exchange-rate moves. The user can change it.
      const cap = estimate === undefined ? 0 : result.draft.amount.currency === 'SATS' ? estimate : Math.max(MIN_PLEDGE, Math.ceil(estimate * 1.5))
      const preview = matchCampaigns(result.draft.target, campaigns, now())[0]?.campaign
      setPending({ parsed: result, estimate, cap, maxRuns: result.draft.limits.maxRuns, preview, auto: agent != null })
      const de = result.lang === 'de'
      say('agent', [
        describeDraft({ ...result.draft, limits: { ...result.draft.limits, maxSatsPerRun: cap } }, result.lang),
        result.draft.amount.currency === 'SATS' ? '' : estimate !== undefined ? (de ? `Das sind heute etwa ${formatSats(estimate)}.` : `That is about ${formatSats(estimate)} today.`) : (de ? 'Ich konnte keinen Wechselkurs laden; bitte setz die Obergrenze in sats selbst.' : 'I could not load an exchange rate; please set the cap in sats yourself.'),
        preview !== undefined ? (de ? `Passende Kampagne gerade: „${preview.meta.title}“.` : `Matching campaign right now: "${preview.meta.title}".`) : (de ? 'Gerade passt keine offene Kampagne; die Routine wartet, bis eine passt.' : 'No open campaign matches right now; the routine waits until one does.'),
        de ? 'Prüf die Details unten und bestätige.' : 'Check the details below and confirm.'
      ].filter(Boolean).join(' '))
    } catch (err) {
      say('agent', `Sorry, that did not work: ${(err as Error).message}`)
    } finally {
      setThinking(false)
    }
  }

  async function createPending () {
    if (pending === undefined) return
    setBusy('create'); setMsg(undefined)
    try {
      const s = await ensureStore()
      if (s === undefined) throw new Error('Connect your wallet to save routines. They are stored under your wallet identity.')
      const { draft } = pending.parsed
      const full: RoutineDraft = { ...draft, limits: { maxSatsPerRun: pending.cap, maxRuns: draft.interval === 'once' ? 1 : pending.maxRuns, maxTotalSats: null } }
      const r = await s.create(full)
      const auto = pending.auto && agent != null
      if (auto) await s.setExecutor(r.id, agent.identityKey)
      setPending(undefined)
      const de = pending.parsed.lang === 'de'
      say('agent', auto
        ? (de
            ? `Gespeichert. Dein Routine-Agent führt „${r.target.label}“ ab jetzt automatisch aus, höchstens ${formatSats(full.limits.maxSatsPerRun)} pro Mal, aus seinem Budget. Die erste Spende ist sofort fällig.`
            : `Saved. Your routine agent now runs "${r.target.label}" automatically, at most ${formatSats(full.limits.maxSatsPerRun)} each time, from its budget. The first gift is due now.`)
        : (de
            ? `Gespeichert. Die erste Spende ist jetzt fällig – du findest sie unten unter „${r.target.label}“ und gibst sie mit deinem Wallet frei.`
            : `Saved. The first gift is due now: approve it below under "${r.target.label}" with your wallet.`))
      void loadAgent()
      if (store === undefined) return // the wallet just connected: the store memo updates and reloads
      await load()
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message })
    } finally { setBusy(undefined) }
  }

  async function act (id: string, fn: () => Promise<{ text: string, txid?: string } | string>) {
    setBusy(id); setMsg(undefined)
    try { const out = await fn(); setMsg(typeof out === 'string' ? { ok: true, text: out } : { ok: true, ...out }); await load() } catch (e) { setMsg({ ok: false, text: (e as Error).message }) } finally { setBusy(undefined) }
  }

  const run = (r: Routine, plan: RunPlan) => act(r.id, async () => {
    if (store === undefined) throw new Error('Connect your wallet first.')
    if (offline) {
      await simulateRoutine(store, r, plan)
      return `Simulated: ${formatSats(plan.sats)} to "${plan.campaign.meta.title}". In the offline demo no transaction is made.`
    }
    const client = await connect()
    if (client === undefined) throw new Error('Could not connect your wallet. Open and unlock BSV Desktop, then try again.')
    if (!confirmSpend(`Giving routine "${r.target.label}": pledge ${formatSats(plan.sats)} (${amountText(r.amount)}) into the escrow of "${plan.campaign.meta.title}"?`)) return 'Cancelled.'
    const { txid } = await executeRoutine(store, client, r, plan)
    return { text: `Pledged ${formatSats(plan.sats)} into "${plan.campaign.meta.title}"'s escrow.`, txid }
  })

  const setStatus = (r: Routine, status: RoutineStatus) => act(r.id, async () => {
    if (status === 'cancelled' && !window.confirm(`Stop the routine "${r.target.label}" for good?`)) return 'Kept.'
    await store!.setStatus(r.id, status)
    return status === 'paused' ? 'Paused. Nothing is proposed until you resume it.' : status === 'active' ? 'Resumed.' : 'Routine stopped.'
  })

  /** Switch a routine between Automatic (delegated to the routine agent) and Manual (approve each gift). */
  const setAuto = (r: Routine, on: boolean) => act(r.id, async () => {
    if (!on) {
      await store!.setExecutor(r.id, null)
      return `"${r.target.label}" is manual again: the agent can no longer run it. You approve each gift.`
    }
    if (agent == null) throw new Error('Start your routine agent first (npm run routine-agent).')
    if (!window.confirm(`Let your routine agent run "${r.target.label}" automatically?\n\nIt may pledge up to ${formatSats(r.limits.maxSatsPerRun)} ${intervalText(r.interval)}, from its own budget (now ${formatSats(agent.balance)}), into a matching campaign's escrow, without asking you each time. Switch back to Manual at any time.`)) return 'Kept manual.'
    await store!.setExecutor(r.id, agent.identityKey)
    return `"${r.target.label}" now runs automatically.`
  })

  const due = routines.filter(r => isDue(r, now()) && !isAutomatic(r))
  const autoCount = routines.filter(r => isAutomatic(r) && (r.status === 'active' || r.status === 'paused')).length

  return (
    <>
      <div className="card">
        <div className="row between">
          <h1>Giving routines</h1>
          <span className="badge agent">AI agent</span>
        </div>
        <p className="small">
          Tell the agent what to give and how often. Each time, it finds a matching campaign and pledges into its escrow.
          Either <strong>you approve every gift in your own wallet</strong>, or you switch a routine to <strong>Automatic</strong> and
          your routine agent runs it from a budget you gave it. Each routine has a hard cap per run that the server also enforces.
        </p>
        {offline && <Notice kind="info">Offline demo: routines are kept in this browser and runs are simulated. No wallet is contacted.</Notice>}
        {!offline && identityKey === undefined && (
          <p className="muted small">
            Your routines are stored under your wallet identity.{' '}
            <button className="secondary" disabled={connecting} onClick={() => { void connect() }}>{connecting ? 'Connecting…' : 'Connect wallet to see them'}</button>
          </p>
        )}

        <div className="chat" aria-live="polite">
          {chat.map((m, i) => <div key={i} className={`bubble ${m.from}`}>{m.text}</div>)}
          {thinking && <div className="bubble agent muted">…</div>}
          {pending !== undefined && (
            <div className="bubble agent draft">
              <dl>
                <dt>Amount</dt><dd>{amountText(pending.parsed.draft.amount)}{pending.estimate !== undefined && pending.parsed.draft.amount.currency !== 'SATS' ? ` ≈ ${formatSats(pending.estimate)}` : ''}</dd>
                <dt>How often</dt><dd>{intervalText(pending.parsed.draft.interval)}</dd>
                <dt>For</dt><dd>{pending.parsed.draft.target.label} <span className="muted small">({pending.parsed.draft.target.keywords.slice(0, 6).join(', ')})</span></dd>
                <dt>Now goes to</dt><dd>{pending.preview !== undefined ? <a href={`#/c/${pending.preview.id}`}>{pending.preview.meta.title}</a> : <span className="muted">no open match yet</span>}</dd>
              </dl>
              <div className="row">
                <label className="small">Cap per run (sats)
                  <input type="number" min={MIN_PLEDGE} value={pending.cap || ''} onChange={e => setPending({ ...pending, cap: Math.floor(Number(e.target.value)) })} style={{ width: '9rem' }} />
                </label>
                <label className="small checkbox">
                  <input type="checkbox" checked={pending.auto} disabled={agent == null} onChange={e => setPending({ ...pending, auto: e.target.checked })} />
                  Run automatically{agent == null ? ' (start your routine agent first)' : ' with my routine agent'}
                </label>
                {pending.parsed.draft.interval !== 'once' && (
                  <label className="small">Number of runs (empty = until stopped)
                    <input type="number" min={1} max={1000} value={pending.maxRuns ?? ''} onChange={e => setPending({ ...pending, maxRuns: e.target.value === '' ? null : Math.floor(Number(e.target.value)) })} style={{ width: '7rem' }} />
                  </label>
                )}
              </div>
              <div className="row">
                <button className="primary" disabled={busy !== undefined || !(pending.cap >= MIN_PLEDGE)} onClick={() => { void createPending() }}>{busy === 'create' ? 'Saving…' : 'Create routine'}</button>
                <button className="secondary" disabled={busy !== undefined} onClick={() => { setPending(undefined); say('agent', 'OK, discarded.') }}>Discard</button>
              </div>
            </div>
          )}
          <div ref={chatEnd} />
        </div>

        <form className="chat-input" onSubmit={e => { void send(e) }}>
          <input value={input} maxLength={280} placeholder='e.g. "Spende jeden Monat 10 Euro an einen Tierschutzverein"' onChange={e => setInput(e.target.value)} aria-label="Message to the giving agent" />
          <button type="submit" className="primary" disabled={thinking || input.trim() === ''}>Send</button>
        </form>
        <div className="presets">
          {EXAMPLES.map(x => <button key={x} type="button" className="chip" disabled={thinking} onClick={() => { void send(undefined, x) }}>{x}</button>)}
        </div>
        {msg !== undefined && (
          <Notice kind={msg.ok ? 'ok' : 'err'}>
            {msg.text} {msg.txid !== undefined && <a href={WOC_TX + msg.txid} target="_blank" rel="noreferrer">View transaction</a>}
          </Notice>
        )}
      </div>

      <RoutineAgentCard agent={agent} autoCount={autoCount} onChange={() => { void loadAgent(); void load() }} />

      {due.length > 0 && (
        <>
          <h2>Due now ({due.length})</h2>
          {due.map(r => {
            const plan = plans[r.id]
            return (
              <div className="card memo" key={r.id}>
                <div className="row between"><h3>{r.target.label}</h3><span className="muted small">{amountText(r.amount)} · {intervalText(r.interval)}</span></div>
                {plan === undefined && <p className="muted small">Working out the campaign and amount…</p>}
                {typeof plan === 'string' && <p className="small err">{plan}</p>}
                {plan !== undefined && typeof plan !== 'string' && (
                  <>
                    <p className="small">Proposed: <strong>{formatSats(plan.sats)}</strong> into the escrow of <a href={`#/c/${plan.campaign.id}`}>{plan.campaign.meta.title}</a> (cap {formatSats(r.limits.maxSatsPerRun)} per run).</p>
                    <div className="row">
                      <button className="primary" disabled={busy !== undefined} onClick={() => { void run(r, plan) }}>{busy === r.id ? 'Approve in your wallet…' : offline ? 'Simulate this run' : `Approve & donate ${formatSats(plan.sats)}`}</button>
                      <button className="secondary" disabled={busy !== undefined} onClick={() => { void setStatus(r, 'paused') }}>Pause</button>
                    </div>
                  </>
                )}
              </div>
            )
          })}
        </>
      )}

      <h2>Your routines ({routines.length})</h2>
      {routines.length === 0 && <p className="muted">{store === undefined && !offline ? 'Connect your wallet to see your routines.' : 'No routines yet. Write one in the chat above.'}</p>}
      {routines.length > 0 && (
        <div className="routine-table">
          <table>
            <thead><tr><th>Routine</th><th>Amount</th><th>How often</th><th>Status</th><th>Given</th><th /></tr></thead>
            <tbody>
              {routines.map(r => (
                <tr key={r.id} className={r.status}>
                  <td>
                    <strong>{r.target.label}</strong>
                    <div className="muted small" title={r.text}>“{r.text}”</div>
                    {r.runs.length > 0 && (
                      <details className="small"><summary>{r.runs.length} run{r.runs.length === 1 ? '' : 's'}</summary>
                        <ul className="runs">
                          {r.runs.map(x => (
                            <li key={x.pledgeId}>
                              {dateTime(x.at)} · {formatSats(x.sats)} → <a href={`#/c/${x.campaignId}`}>{x.campaignTitle}</a>{' '}
                              {x.simulated === true ? <span className="muted">simulated</span> : <a href={WOC_TX + x.pledgeId.split('.')[0]} target="_blank" rel="noreferrer">{short(x.pledgeId.split('.')[0])}</a>}
                            </li>
                          ))}
                        </ul>
                      </details>
                    )}
                  </td>
                  <td>{amountText(r.amount)}<div className="muted small">cap {formatSats(r.limits.maxSatsPerRun)}</div></td>
                  <td>{intervalText(r.interval)}{r.limits.maxRuns !== null && r.interval !== 'once' && <div className="muted small">{r.runs.length}/{r.limits.maxRuns} runs</div>}</td>
                  <td>
                    <span className={`badge routine-${r.status}`}>{isDue(r, now()) ? (isAutomatic(r) ? 'Due · agent' : 'Due') : STATUS_LABEL[r.status]}</span>
                    {isAutomatic(r) && (
                      <div className="small">
                        <span className="badge agent">Automatic</span>
                        {agent != null && r.executor!.identityKey !== agent.identityKey && <span className="err"> delegated to another agent key</span>}
                      </div>
                    )}
                    {r.status === 'active' && r.nextRunAt !== null && !isDue(r, now()) && <div className="muted small">next {dateTime(r.nextRunAt)}</div>}
                  </td>
                  <td>{formatSats(totalGiven(r))}</td>
                  <td className="actions">
                    {(r.status === 'active' || r.status === 'paused') && (isAutomatic(r)
                      ? <button className="secondary" disabled={busy !== undefined} onClick={() => { void setAuto(r, false) }}>Manual</button>
                      : <button className="secondary" disabled={busy !== undefined || agent == null} title={agent == null ? 'Start your routine agent first' : undefined} onClick={() => { void setAuto(r, true) }}>Automatic</button>)}
                    {r.status === 'active' && <button className="secondary" disabled={busy !== undefined} onClick={() => { void setStatus(r, 'paused') }}>Pause</button>}
                    {r.status === 'paused' && <button className="secondary" disabled={busy !== undefined} onClick={() => { void setStatus(r, 'active') }}>Resume</button>}
                    {(r.status === 'active' || r.status === 'paused') && <button className="secondary" disabled={busy !== undefined} onClick={() => { void setStatus(r, 'cancelled') }}>Stop</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}
