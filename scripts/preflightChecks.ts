/**
 * The video's "Before recording" list (docs/VIDEO_SCRIPT.md) as checks. Read-only: it only GETs the
 * local services' status pages and tests whether a port accepts connections. It never calls a wallet,
 * never spends, and never prints a secret (only whether one is set).
 */
export interface Check { name: string, status: 'ok' | 'warn' | 'fail', detail: string }

export interface PreflightDeps {
  fetch: typeof fetch
  env: Record<string, string | undefined>
  /** Does something accept TCP connections on 127.0.0.1:port? */
  portOpen: (port: number) => Promise<boolean>
}

export async function runPreflight (d: PreflightDeps): Promise<Check[]> {
  const e = d.env
  const network = e.NETWORK === 'test' ? 'test' : 'main'
  const url = { server: e.CRYPTOPLEDGEPOT_URL ?? 'http://localhost:8787', data: e.DATA_URL ?? 'http://localhost:8790', agent: `http://localhost:${e.AGENT_PORT ?? 8791}`, donor: `http://127.0.0.1:${e.DONOR_PORT ?? 8792}` }
  const get = async (u: string): Promise<any> => { const r = await d.fetch(u); if (!r.ok) throw new Error(`HTTP ${r.status}`); return await r.json() }
  const out: Check[] = []
  const check = async (name: string, fn: () => Promise<Omit<Check, 'name'>>): Promise<void> => {
    try { out.push({ name, ...(await fn()) }) } catch (err) { out.push({ name, status: 'fail', detail: `not reachable (${(err as Error).message})` }) }
  }

  await check('server on the right network', async () => {
    const h = await get(`${url.server}/api/health`)
    return h.network === network ? { status: 'ok', detail: `${url.server} says ${h.network}` } : { status: 'fail', detail: `${url.server} says ${h.network}, expected ${network}` }
  })
  await check('data provider serves real data', async () => {
    const p = await get(`${url.data}/`)
    return /open-meteo/i.test(String(p.source)) ? { status: 'ok', detail: `${p.source}, ${p.priceSats} sats per call` } : { status: 'warn', detail: `source is ${p.source}; the video says real Open-Meteo data` }
  })
  await check('fundraising agent: Claude brain, a campaign, a fee float', async () => {
    const a = await get(`${url.agent}/api/agent`)
    const problems = [
      !String(a.brain ?? '').startsWith('claude') && `brain is ${a.brain ?? 'unknown'}, not claude (set ANTHROPIC_API_KEY and restart it)`,
      a.campaignId === null && 'no campaign launched yet',
      Number(a.balance) < 3_000 && `fee float ${a.balance} sats < 3,000 (use "Top up agent fees")`
    ].filter(Boolean)
    return problems.length === 0 ? { status: 'ok', detail: `brain ${a.brain}, campaign ${String(a.campaignId).slice(0, 12)}…, ${a.balance} sats` } : { status: 'fail', detail: problems.join('; ') }
  })
  await check('donor agent in co-pilot mode for backer 1', async () => {
    const m = await get(`${url.donor}/api/donor`)
    const problems = [m.mode !== 'copilot' && `mode is ${m.mode}, not copilot`, m.donorIdentityKey === null && 'no donorIdentityKey in the mandate'].filter(Boolean)
    return problems.length === 0 ? { status: 'ok', detail: `copilot, brain ${m.brain}` } : { status: 'fail', detail: problems.join('; ') }
  })
  await check('Anthropic key present', async () => (e.ANTHROPIC_API_KEY ?? '') !== ''
    ? { status: 'ok', detail: 'ANTHROPIC_API_KEY is set (value not shown)' }
    : { status: 'fail', detail: 'ANTHROPIC_API_KEY is not set: paste it into ~/.config/cryptopledgepot/secrets.env (docs/KEYS.md)' })
  await check('web app running', async () => {
    const port = Number(e.APP_PORT ?? 5174) // app/vite.config.ts (strictPort)
    return await d.portOpen(port) ? { status: 'ok', detail: `something listens on :${port}` } : { status: 'fail', detail: `nothing on :${port}: run npm run app` }
  })
  await check('BSV Desktop listening', async () => {
    const open = await d.portOpen(3321) || await d.portOpen(2121)
    return open ? { status: 'ok', detail: 'a wallet port (3321/2121) accepts connections' } : { status: 'fail', detail: 'no wallet on 3321/2121: open BSV Desktop' }
  })
  out.push({ name: 'no browser automation while the wallet is open', status: 'warn', detail: 'cannot be checked automatically: make sure no automation tool is driving the browser; every payment is clicked by a person' })
  return out
}
