/** Step 4: the agent's public endpoint: status, ledger, and BRC-29 top-ups. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import type { Wallet } from '@bsv/wallet-toolbox'
import { createAgentApp } from '../agent/http'
import { Ledger, memoryStore, type AgentState, type SpendEntry } from '../agent/ledger'
import { createBrc29Payment } from '../client/payments'
import { createMockChain, type MockChain } from './helpers/mockchain'

let chain: MockChain
let agentWallet: Wallet, operator: Wallet
let server: Server
let url: string
const ledger = new Ledger(memoryStore<SpendEntry[]>([]))

const spendable = async (w: Wallet): Promise<number> =>
  (await w.listOutputs({ basket: 'default', limit: 1000 })).outputs.filter(o => o.spendable).reduce((s, o) => s + o.satoshis, 0)

beforeAll(async () => {
  chain = await createMockChain()
  agentWallet = await chain.makeWallet()
  operator = await chain.makeWallet()
  await chain.fund(operator, 50_000)
  ledger.add({ milestone: 1, topic: 'munich', why: 'test', url: 'http://x/data/munich', sats: 50, txid: 'ab'.repeat(32), at: 1 })
  const app = createAgentApp({
    wallet: agentWallet,
    ledger,
    state: memoryStore<AgentState>({ campaignId: 'cd'.repeat(32), worked: [1] }),
    chainTracker: chain.chainTracker,
    mission: 'test mission',
    spendable: async () => await spendable(agentWallet),
    lastOutcome: () => ({ action: 'waiting', reason: 'test' })
  })
  await new Promise<void>(resolve => { server = app.listen(0, () => resolve()) })
  url = `http://127.0.0.1:${(server.address() as any).port}`
})
afterAll(async () => { await new Promise(r => server?.close(r)); await chain?.close() })

describe('agent HTTP endpoint', () => {
  it('reports status and the spend ledger', async () => {
    const status = await (await fetch(`${url}/api/agent`)).json()
    expect(status).toMatchObject({ identityKey: agentWallet.identityKey, mission: 'test mission', campaignId: 'cd'.repeat(32), balance: 0, spent: { calls: 1, sats: 50 } })
    expect(await (await fetch(`${url}/api/agent/ledger`)).json()).toHaveLength(1)
  })

  it('accepts a BRC-29 top-up from the operator; the agent can spend it at once', async () => {
    const payment = await createBrc29Payment(operator, agentWallet.identityKey, 5_000, 'Top up agent')
    const res = await fetch(`${url}/api/agent/fund`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payment) })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, balance: 5_000 })
  })

  it('rejects a payment that is not for the agent', async () => {
    const stranger = await chain.makeWallet()
    const payment = await createBrc29Payment(operator, stranger.identityKey, 1_000)
    const res = await fetch(`${url}/api/agent/fund`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payment) })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/not locked to our key/)
  })
})
