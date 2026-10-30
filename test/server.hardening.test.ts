/** Fixes from the self-evaluation: network reporting (demo safety) and JSON errors. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import { createCryptoPledgePotApp } from '../server/app'
import { CryptoPledgePotDb } from '../server/db'
import { createMockChain, memoryKnex, type MockChain } from './helpers/mockchain'

let chain: MockChain
const servers: Server[] = []
const start = async (network?: 'main' | 'test' | 'mock'): Promise<string> => {
  const db = new CryptoPledgePotDb(memoryKnex()); await db.migrate()
  const app = createCryptoPledgePotApp({ wallet: await chain.makeWallet(), db, chainTracker: chain.chainTracker, network })
  return await new Promise(resolve => { const s = app.listen(0, () => resolve(`http://127.0.0.1:${(s.address() as any).port}`)); servers.push(s) })
}

beforeAll(async () => { chain = await createMockChain() })
afterAll(async () => { for (const s of servers) await new Promise(r => s.close(r)); await chain?.close() })

describe('server hardening', () => {
  it('reports its network so the web app can refuse wallet actions in the offline demo', async () => {
    expect((await (await fetch(`${await start('mock')}/api/health`)).json()).network).toBe('mock')
    expect((await (await fetch(`${await start()}/api/health`)).json()).network).toBe('main')
  })

  it('answers an oversized or malformed body with JSON, not an HTML page', async () => {
    const url = await start('main')
    const big = await fetch(`${url}/api/spends`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ beef: '00'.repeat(11_000_000) }) })
    expect(big.status).toBe(413)
    expect(await big.json()).toEqual({ error: 'request body too large' })
    const bad = await fetch(`${url}/api/spends`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"beef":' })
    expect(bad.status).toBe(400)
    expect(await bad.json()).toEqual({ error: 'malformed JSON body' })
  })
})

describe('rate limits for public traffic (via a tunnel on this machine)', () => {
  const startLimited = async (): Promise<string> => {
    const db = new CryptoPledgePotDb(memoryKnex()); await db.migrate()
    const app = createCryptoPledgePotApp({ wallet: await chain.makeWallet(), db, chainTracker: chain.chainTracker, limits: { spvPerMinute: 3, feedsPerIp: 2 } })
    return await new Promise(resolve => { const s = app.listen(0, () => resolve(`http://127.0.0.1:${(s.address() as any).port}`)); servers.push(s) })
  }
  const spend = async (url: string, ip?: string) => await fetch(`${url}/api/spends`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(ip !== undefined ? { 'X-Forwarded-For': ip } : {}) }, body: '{"beef":"zz"}'
  })

  it('limits each visitor separately, and never limits the machine itself', async () => {
    const url = await startLimited()
    const statuses = [] as number[]
    for (let i = 0; i < 4; i++) statuses.push((await spend(url, '203.0.113.5')).status)
    expect(statuses).toEqual([400, 400, 400, 429]) // 3 allowed (bad input → 400), the 4th refused
    const refused = await spend(url, '203.0.113.5')
    expect(await refused.json()).toMatchObject({ error: expect.stringMatching(/too many submissions/) })
    expect(refused.headers.get('retry-after')).toMatch(/^\d+$/)
    expect((await spend(url, '198.51.100.7')).status).toBe(400) // another visitor is unaffected
    for (let i = 0; i < 5; i++) expect((await spend(url)).status).toBe(400) // local calls: no limit
  })

  it('caps open live-feed connections per visitor', async () => {
    const url = await startLimited()
    const open = async (ip: string) => await fetch(`${url}/api/campaigns/${'a'.repeat(64)}/events`, { headers: { 'X-Forwarded-For': ip } })
    const a = await open('203.0.113.9')
    const b = await open('203.0.113.9')
    expect([a.status, b.status]).toEqual([200, 200])
    const c = await open('203.0.113.9')
    expect(c.status).toBe(429)
    await a.body?.cancel(); await b.body?.cancel()
  })
})
