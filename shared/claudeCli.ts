/**
 * Ask Claude through the Claude Code CLI (`claude -p`) instead of the API: uses the local Claude Code
 * login, so no ANTHROPIC_API_KEY is needed. For LOCAL TESTING of the agents' brains (e.g. the eval);
 * every call counts against the Claude Code usage limits. A deployed agent should use the API.
 *
 * Same contract as the SDK path: a system prompt, a user message, and a zod schema the answer must
 * satisfy (sent as --json-schema, validated again here). No tools, no saved session, and a neutral
 * working directory, so no project instructions leak into the agent's judgement.
 */
import { spawn } from 'node:child_process'
import os from 'node:os'
import { z } from 'zod'

export interface ClaudeCliOptions {
  model: string
  /** The CLI binary; default CLAUDE_BIN or `claude` on PATH. */
  bin?: string
  timeoutMs?: number
}

export async function askClaudeCli<T> (schema: z.ZodType<T>, system: string, user: string, o: ClaudeCliOptions): Promise<T> {
  // The CLI's validator doesn't know zod's "$schema: draft 2020-12" header; the schema body is plain JSON Schema.
  const { $schema: _, ...jsonSchema } = z.toJSONSchema(schema) as Record<string, unknown>
  const args = ['-p', '--output-format', 'json', '--no-session-persistence', '--tools', '', '--model', o.model,
    '--system-prompt', system, '--json-schema', JSON.stringify(jsonSchema)]
  const { stdout, stderr, code } = await new Promise<{ stdout: string, stderr: string, code: number | null }>((resolve, reject) => {
    const p = spawn(o.bin ?? process.env.CLAUDE_BIN ?? 'claude', args, { cwd: os.tmpdir(), stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''; let stderr = ''
    const timer = setTimeout(() => { p.kill(); reject(new Error('claude -p timed out')) }, o.timeoutMs ?? 180_000)
    p.stdout.on('data', d => { stdout += String(d) }); p.stderr.on('data', d => { stderr += String(d) })
    p.on('error', e => { clearTimeout(timer); reject(new Error(`could not run the Claude Code CLI: ${e.message}`)) })
    p.on('close', code => { clearTimeout(timer); resolve({ stdout, stderr, code }) })
    p.stdin.end(user)
  })
  let out: { is_error?: boolean, result?: string, structured_output?: unknown, stop_reason?: string }
  try { out = JSON.parse(stdout) } catch { throw new Error(`claude -p failed (exit ${code}): ${(stderr || stdout).slice(0, 300)}`) }
  if (out.is_error === true) throw new Error(`claude -p: ${String(out.result ?? 'error').slice(0, 300)}`)
  if (out.structured_output == null) throw new Error(`no structured output (stop_reason: ${out.stop_reason ?? 'unknown'})`)
  return schema.parse(out.structured_output)
}
