/** "AirWatch live": the whole agent story, at full speed, with exact numbers. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CryptoPledgePotApi } from '../client/cryptoPledgePotApi'
import { runAgentDemo, type AgentDemo } from '../server/agentDemo'

let demo: AgentDemo
const lines: string[] = []

beforeAll(async () => {
  demo = await runAgentDemo({ port: 0, dataPort: 0, agentPort: 0, paceMs: 0, log: l => lines.push(l) })
  await demo.done
}, 300_000)
afterAll(async () => { await demo?.close() })

describe('the AirWatch live story', () => {
  it('plays every beat to the end', async () => {
    expect(demo.status()).toMatchObject({ done: true, step: 16, total: 16 })
    expect(demo.status().error).toBeUndefined()
    const fromApi = await (await fetch(`${demo.url}/api/demo`)).json()
    expect(fromApi).toMatchObject({ title: 'AirWatch live', done: true, step: 16 })
  })

  it('ends with the agent campaign completed and every escrowed sat released', async () => {
    const c = await new CryptoPledgePotApi(demo.url).campaign(demo.status().campaignId!)
    expect(c).toMatchObject({ status: 'completed', raised: 30_000, released: 30_000, escrowed: 0, donors: 5, milestonesReleased: 3 })
    expect(c.meta.kind).toBe('agent')
    expect(c.milestones[1].votes).toMatchObject({ yes: 20_000, no: 6_000, voters: 3 }) // Ben voted no
    expect(c.milestones[2].votes).toMatchObject({ yes: 16_000, voters: 3 })
    expect(c.milestones[1].update?.note).toMatch(/5 readings bought for 250 sats/)
    expect(c.milestones[2].update?.note).toMatch(/5 readings bought for 250 sats/) // the refused city is replaced by a re-plan
  })

  it('the agent paid per call, never above its cap, and refused the premium price', () => {
    const byMilestone = [1, 2, 3].map(m => demo.ledger.forMilestone(m))
    expect(byMilestone.map(e => e.length)).toEqual([5, 5, 5]) // a refused purchase is re-planned; later milestones skip it
    expect(demo.ledger.all().every(e => e.sats === 50 && /^[0-9a-f]{64}$/.test(e.txid ?? ''))).toBe(true)
    expect(demo.ledger.all().some(e => e.topic === 'zurich')).toBe(false)
    expect(demo.ledger.totals()).toEqual({ calls: 15, sats: 750 })
    const refusals = lines.filter(l => /refused to pay: .*zurich asks 500 sats/.test(l))
    expect(refusals).toHaveLength(1) // milestone 2; afterwards the brain is told zurich is unavailable
  })

  it('shows its reasoning on its status page', async () => {
    const agentUrl = (await new CryptoPledgePotApi(demo.url).campaign(demo.status().campaignId!)).meta.agentUrl!
    const status = await (await fetch(`${agentUrl}/api/agent`)).json()
    const activity: string[] = status.activity.map((a: { line: string }) => a.line)
    expect(activity.some(l => /^brain \(mock\) plans 5 purchase\(s\)/.test(l))).toBe(true)
    expect(activity.some(l => /refused to pay/.test(l))).toBe(true)
    expect(status.spent).toEqual({ calls: 15, sats: 750 })
  })
})
