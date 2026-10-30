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
