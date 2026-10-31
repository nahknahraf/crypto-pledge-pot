/**
 * The secrets file (core/loadEnv.ts): create it, add missing keys, fill empty ones.
 * Values are never printed. The file stays mode 600.
 */
import fs from 'node:fs'
import path from 'node:path'
import { DEFAULT_SECRETS_FILE, parseEnv } from '../core/loadEnv'

export const secretsFile = (): string => process.env.CPP_SECRETS_FILE ?? DEFAULT_SECRETS_FILE

export const TEMPLATE = `# CryptoPledgePot secrets. Paste values after the "=". Empty lines are ignored.
# This file is outside the repository on purpose: never copy it into the repo.

# --- Claude (fundraising/donor brains, npm run eval:agents) ---
ANTHROPIC_API_KEY=

# --- Bridge on an EVM chain (Base Sepolia for testing): 0x-prefixed 32-byte hex private keys ---
# Use fresh TESTNET-ONLY keys. Never a key that holds real funds.
BRIDGE_CHAIN=base-sepolia
BRIDGE_RPC_URL=
BRIDGE_DEPLOYER_KEY=
# npm run demo:bridge: the donor and the LP; npm run lp: LP_EVM_KEY (may be the same key as BRIDGE_LP_KEY)
BRIDGE_DONOR_KEY=
BRIDGE_LP_KEY=
LP_EVM_KEY=
# Addresses: BRIDGE_HTLC from npm run evm:deploy; BRIDGE_TOKEN is the test USDC (see Circle's docs)
BRIDGE_HTLC=
BRIDGE_TOKEN=

# --- Bitcoin leg: npm run lp with BRIDGE_CHAIN=btc-signet (or btc, btc-regtest) ---
# The agent's BTC key (hex), fresh and signet-only to start with. Never a key holding real funds.
LP_BTC_KEY=
LP_SATS_PER_BTC=
# Either your own node (with -txindex)…
BTC_RPC_URL=
BTC_RPC_USER=
BTC_RPC_PASSWORD=
# …or an Esplora API (default https://mempool.space[/signet]/api)
BTC_ESPLORA_URL=

# --- Lightning leg: npm run lp with BRIDGE_CHAIN=ln (your own LND node) ---
LND_REST_URL=
LND_MACAROON_PATH=
LND_TLS_CERT_PATH=

# --- Optional: server-side BSV root keys (otherwise generated into data/*.key) ---
AGENT_ROOT_KEY=
LP_ROOT_KEY=
`

const keysOf = (text: string): string[] => [...text.matchAll(/^([A-Z_0-9]+)=/gm)].map(m => m[1])

/** Create the file from the template, or append template keys it lacks (empty). Returns what changed. */
export function ensureSecretsFile (file = secretsFile()): { created: boolean, added: string[] } {
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    fs.writeFileSync(file, TEMPLATE, { mode: 0o600 })
    return { created: true, added: [] }
  }
  const text = fs.readFileSync(file, 'utf8')
  const have = new Set(keysOf(text))
  const added = keysOf(TEMPLATE).filter(k => !have.has(k))
  if (added.length > 0) fs.appendFileSync(file, `\n# Added by npm run secrets:init (see docs/KEYS.md)\n${added.map(k => `${k}=`).join('\n')}\n`)
  return { created: false, added }
}

/** Keys that have a value (names only). */
export const filledKeys = (file = secretsFile()): string[] => Object.entries(parseEnv(fs.readFileSync(file, 'utf8'))).filter(([, v]) => v !== '').map(([k]) => k)

/** Set each key that is EMPTY in the file; never overwrites a value. Returns the keys set. */
export function fillEmpty (values: Record<string, string>, file = secretsFile()): string[] {
  const set: string[] = []
  const lines = fs.readFileSync(file, 'utf8').split('\n').map(line => {
    const m = line.match(/^([A-Z_0-9]+)=\s*$/)
    if (m === null || values[m[1]] === undefined || set.includes(m[1])) return line
    set.push(m[1])
    return `${m[1]}=${values[m[1]]}`
  })
  fs.writeFileSync(file, lines.join('\n'), { mode: 0o600 })
  return set
}
