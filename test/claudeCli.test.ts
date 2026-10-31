/**
 * The Claude Code CLI path (shared/claudeCli.ts) with a fake `claude` binary: the brain sends the same
 * schema, parses `structured_output`, and still applies its code rules; errors are reported, not swallowed.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { ClaudeCliBrain } from '../fundraising-agent/brain'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-claude-'))
const fake = (name: string, stdout: unknown): string => {
  const f = path.join(dir, name)
  // Records its arguments and stdin, then prints a canned CLI result.
  fs.writeFileSync(f, `#!/bin/sh\nprintf '%s\\n' "$@" > "${f}.args"\ncat > "${f}.stdin"\ncat <<'JSON'\n${JSON.stringify(stdout)}\nJSON\n`, { mode: 0o755 })
  return f
}
const input = { mission: 'Map air quality.', milestone: { index: 1, title: 'First cities' }, maxCalls: 2, alreadyBought: [] }
afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); delete process.env.CLAUDE_BIN })

describe('Claude through the Claude Code CLI (no API key)', () => {
  it('sends the schema with no tools and no session, and the brain\'s code rules still apply', async () => {
    process.env.CLAUDE_BIN = fake('ok', { is_error: false, structured_output: { calls: [{ topic: 'munich', why: 'a' }, { topic: 'atlantis', why: 'not a city we sell' }, { topic: 'paris', why: 'b' }, { topic: 'rome', why: 'over the cap' }] } })
    const brain = new ClaudeCliBrain('claude-sonnet-5-5')
    expect(brain.name).toBe('claude-cli:claude-sonnet-5-5')
    const plan = await brain.planCalls(input)
    expect(plan.map(p => p.topic)).toEqual(['munich', 'paris']) // unknown topic dropped, capped at maxCalls (sanitizePlan)
    const args = fs.readFileSync(`${process.env.CLAUDE_BIN}.args`, 'utf8').split('\n')
    expect(args).toEqual(expect.arrayContaining(['-p', '--no-session-persistence', '--tools', '', '--model', 'claude-sonnet-5-5', '--json-schema']))
    const sent = JSON.parse(args[args.indexOf('--json-schema') + 1])
    expect(sent.type).toBe('object')
    expect(sent.$schema).toBeUndefined() // the real CLI rejects zod's draft 2020-12 header
    expect(fs.readFileSync(`${process.env.CLAUDE_BIN}.stdin`, 'utf8')).toMatch(/Mission: Map air quality/)
  })
  it('reports CLI errors and answers that break the schema', async () => {
    process.env.CLAUDE_BIN = fake('err', { is_error: true, result: 'Not logged in' })
    await expect(new ClaudeCliBrain().planCalls(input)).rejects.toThrow(/Not logged in/)
    process.env.CLAUDE_BIN = fake('bad', { is_error: false, structured_output: { calls: 'nope' } })
    await expect(new ClaudeCliBrain().planCalls(input)).rejects.toThrow()
    process.env.CLAUDE_BIN = path.join(dir, 'missing')
    await expect(new ClaudeCliBrain().planCalls(input)).rejects.toThrow(/could not run the Claude Code CLI/)
  })
})
