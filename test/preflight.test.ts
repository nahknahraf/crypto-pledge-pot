/** The video pre-flight (scripts/preflightChecks.ts) with stubbed services: all good, then each way it can be wrong. */
import { describe, expect, it } from 'vitest'
import { runPreflight } from '../scripts/preflightChecks'

const good: Record<string, unknown> = {
  'http://localhost:8787/api/health': { ok: true, network: 'main' },
  'http://localhost:8790/': { source: 'Open-Meteo (CAMS), resold per call', priceSats: 50 },
  'http://localhost:8791/api/agent': { brain: 'claude:claude-opus-5-5', campaignId: 'ab'.repeat(32), balance: 3_200 },
  'http://127.0.0.1:8792/api/donor': { mode: 'copilot', donorIdentityKey: '02' + 'cd'.repeat(32), brain: 'mock' }
}
const run = async (over: Record<string, unknown> = {}, env: Record<string, string> = { ANTHROPIC_API_KEY: 'sk-x' }, open = [5174, 3321]) => {
  const routes = { ...good, ...over }
  const fetchStub = (async (u: string) => routes[u] === undefined ? new Response('', { status: 404 }) : new Response(JSON.stringify(routes[u]))) as typeof fetch
  return await runPreflight({ fetch: fetchStub, env, portOpen: async p => open.includes(p) })
}
const byName = (cs: Awaited<ReturnType<typeof run>>, part: string) => cs.find(c => c.name.includes(part))!

describe('video pre-flight checks', () => {
  it('all good: everything ok except the one thing a script cannot check', async () => {
    const cs = await run()
    expect(cs.filter(c => c.status === 'fail')).toEqual([])
    expect(cs.filter(c => c.status === 'warn').map(c => c.name)).toEqual(['no browser automation while the wallet is open'])
  })
  it('catches the mistakes that would spoil a mainnet recording', async () => {
    const cs = await run({
      'http://localhost:8787/api/health': { network: 'mock' },
      'http://localhost:8791/api/agent': { brain: 'mock', campaignId: null, balance: 100 },
      'http://127.0.0.1:8792/api/donor': { mode: 'autopilot', donorIdentityKey: null }
    }, {}, [])
    expect(byName(cs, 'server').detail).toMatch(/says mock, expected main/)
    expect(byName(cs, 'fundraising').detail).toMatch(/brain is mock.*no campaign.*fee float 100/)
    expect(byName(cs, 'donor').detail).toMatch(/autopilot.*donorIdentityKey/)
    expect(byName(cs, 'Anthropic').status).toBe('fail')
    expect(byName(cs, 'web app').status).toBe('fail')
    expect(byName(cs, 'BSV Desktop').status).toBe('fail')
  })
  it('a service that is down is a failure with a reason, not a crash; secrets are never echoed', async () => {
    const cs = await run({ 'http://localhost:8790/': undefined })
    expect(byName(cs, 'data provider')).toMatchObject({ status: 'fail', detail: expect.stringMatching(/not reachable/) })
    expect(JSON.stringify(cs)).not.toContain('sk-x')
  })
})
