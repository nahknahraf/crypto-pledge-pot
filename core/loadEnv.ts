/**
 * Secrets (API keys, EVM keys, RPC URLs with tokens) live in ONE file outside the repository:
 *
 *   ~/.config/cryptopledgepot/secrets.env    (chmod 600; created by `npm run secrets:init`)
 *
 * Outside the repo, it can't be committed, served by `npm run share:internet`, or copied into a
 * container build. Every `npm run <entrypoint>` imports this module first. Variables already set in
 * the shell win over the file. `CPP_SECRETS_FILE` points at another file; `CPP_SECRETS_FILE=none` skips it.
 * Node only: never import this from app/ (browser) code.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const DEFAULT_SECRETS_FILE = path.join(os.homedir(), '.config', 'cryptopledgepot', 'secrets.env')

/** Load the secrets file into process.env (without overriding). Returns the file used, or undefined. */
export function loadSecrets (file = process.env.CPP_SECRETS_FILE ?? DEFAULT_SECRETS_FILE): string | undefined {
  if (file === 'none' || !fs.existsSync(file)) return undefined
  if (process.platform !== 'win32' && (fs.statSync(file).mode & 0o077) !== 0) {
    console.warn(`warning: ${file} is readable by other users; run: chmod 600 '${file}'`)
  }
  // Only fill gaps: the shell's own environment takes precedence, and empty values are ignored.
  for (const [k, v] of Object.entries(parseEnv(fs.readFileSync(file, 'utf8')))) {
    if (v !== '' && process.env[k] === undefined) process.env[k] = v
  }
  return file
}

/** KEY=value lines; # comments; optional single or double quotes. No variable expansion. */
export function parseEnv (text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of text.split(/\r?\n/)) {
    const m = raw.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/)
    if (m === null) continue
    let v = m[2]
    if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1)
    else v = v.replace(/\s+#.*$/, '')
    out[m[1]] = v
  }
  return out
}

loadSecrets()
