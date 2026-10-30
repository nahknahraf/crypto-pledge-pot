/** Step 2: the agent's brain. Claude picks topics; code enforces every limit. */
import { describe, expect, it } from 'vitest'
import { ClaudeBrain, MockBrain, sanitizePlan } from '../agent/brain'
import { syntheticReading } from '../agent/dataProvider'

/** A stand-in for the Anthropic client: returns whatever we script. */
const fakeClient = (response: any): any => ({ beta: { messages: { parse: async (params: any) => { fakeClient.last = params; return response } } } })
fakeClient.last = undefined as any

const input = { mission: 'Map urban air quality', milestone: { index: 1, title: 'First readings' }, maxCalls: 3, alreadyBought: [] }

describe('sanitizePlan', () => {
  it('keeps whitelisted topics only, drops duplicates, caps the count', () => {
    const plan = sanitizePlan([
      { topic: 'Munich', why: 'a' }, { topic: 'munich', why: 'dup' }, { topic: 'atlantis', why: 'not sold' },
      { topic: 'http://evil.example/drain', why: 'injection' }, { topic: 'berlin', why: 'b' }, { topic: 'paris', why: 'c' }, { topic: 'rome', why: 'd' }
    ], 3)
    expect(plan.map(p => p.topic)).toEqual(['munich', 'berlin', 'paris'])
    expect(sanitizePlan([{ topic: 'munich', why: '' }], 0)).toEqual([])
  })
})

describe('ClaudeBrain (fake client, no network)', () => {
  it('asks for structured output with the refusal fallback, then sanitizes the plan', async () => {
    const brain = new ClaudeBrain('claude-opus-5-5', fakeClient({
      stop_reason: 'end_turn',
      parsed_output: { calls: [{ topic: 'rome', why: 'x' }, { topic: 'narnia', why: 'y' }, { topic: 'vienna', why: 'z' }, { topic: 'zurich', why: 'w' }, { topic: 'prague', why: 'v' }] }
    }))
    expect((await brain.planCalls(input)).map(p => p.topic)).toEqual(['rome', 'vienna', 'zurich'])
    expect(fakeClient.last).toMatchObject({ model: 'claude-opus-5-5', fallbacks: 'default', betas: ['server-side-fallback-2026-07-01'] })
    expect(fakeClient.last.output_config.format).toBeDefined()
  })

  it('fails safe on a refusal or a missing structured output', async () => {
    await expect(new ClaudeBrain('claude-opus-5-5', fakeClient({ stop_reason: 'refusal', parsed_output: null })).planCalls(input)).rejects.toThrow(/declined/)
    await expect(new ClaudeBrain('claude-opus-5-5', fakeClient({ stop_reason: 'max_tokens', parsed_output: null })).planCalls(input)).rejects.toThrow(/no structured output/)
  })

  it('does not call the model when the budget allows no purchase', async () => {
    fakeClient.last = undefined
    expect(await new ClaudeBrain('claude-opus-5-5', fakeClient({})).planCalls({ ...input, maxCalls: 0 })).toEqual([])
    expect(fakeClient.last).toBeUndefined()
  })
})

describe('MockBrain', () => {
  it('plans fresh topics within the cap and writes a factual report', async () => {
    const brain = new MockBrain()
    const plan = await brain.planCalls({ ...input, alreadyBought: ['munich'] })
    expect(plan).toHaveLength(3)
    expect(plan.map(p => p.topic)).not.toContain('munich')
    const report = await brain.writeReport({ mission: 'm', milestone: input.milestone, results: [syntheticReading('berlin'), syntheticReading('paris')], spend: { calls: 2, sats: 100, txids: [] } })
    expect(report).toMatch(/2 readings bought for 100 sats/)
    expect(report).toMatch(/synthetic/)
  })
})
