/**
 * Smoke test for `npm run demo` (the offline world behind the web app): start
 * it as a child process on free ports, wait until it serves campaigns, check
 * that every state the UI shows is there, stop it.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { freePort } from '../liquidity-agent/anvil'

let proc: ChildProcess | undefined
afterAll(() => { if (proc?.pid !== undefined) try { process.kill(-proc.pid, 'SIGTERM') } catch {} })

describe('npm run demo', () => {
  it('serves campaigns in every state, including an AI-agent campaign, in mock mode', async () => {
    const [port, dataPort, agentPort] = [await freePort(), await freePort(), await freePort()]
    proc = spawn('npx', ['vite-node', '--config', 'vitest.config.ts', 'server/demo.ts'], {
      env: { ...process.env, PORT: String(port), DATA_PORT: String(dataPort), AGENT_PORT: String(agentPort) }, stdio: 'ignore', detached: true
    })
    let list: any[] = []
    // The demo world builds its campaigns one by one (the AI-agent one last): poll until all of them are there.
    const ready = (): boolean => list.length >= 4 && list.some(c => c.meta?.kind === 'agent') && ['active', 'failed'].every(st => list.some(c => c.status === st))
    for (let i = 0; i < 120 && !ready(); i++) {
      try { const r = await fetch(`http://127.0.0.1:${port}/api/campaigns`); if (r.ok) list = await r.json() as any[] } catch {}
      if (!ready()) await new Promise(resolve => setTimeout(resolve, 1000))
    }
    const health = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json() as { network: string }
    expect(health.network).toBe('mock')
    const statuses = new Set(list.map(c => c.status))
    for (const s of ['active', 'failed']) expect(statuses, [...statuses].join(',')).toContain(s)
    expect(list.some(c => c.meta?.kind === 'agent')).toBe(true)
  }, 180_000)
})
