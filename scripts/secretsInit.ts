/**
 * npm run secrets:init: create the secrets file (see core/loadEnv.ts) with every key the
 * project reads, empty, readable only by you. Never overwrites an existing file; never prints values.
 */
import fs from 'node:fs'
import path from 'node:path'
import { DEFAULT_SECRETS_FILE, parseEnv } from '../core/loadEnv'

const TEMPLATE = `# CryptoPledgePot secrets. Paste values after the "=". Empty lines are ignored.
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

# --- Optional: server-side BSV root keys (otherwise generated into data/*.key) ---
AGENT_ROOT_KEY=
LP_ROOT_KEY=
`

const file = process.env.CPP_SECRETS_FILE ?? DEFAULT_SECRETS_FILE
if (fs.existsSync(file)) {
  const set = Object.entries(parseEnv(fs.readFileSync(file, 'utf8'))).filter(([, v]) => v !== '').map(([k]) => k)
  console.log(`${file} already exists (not changed). Keys with a value: ${set.join(', ') || 'none'}`)
} else {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  fs.writeFileSync(file, TEMPLATE, { mode: 0o600 })
  console.log(`created ${file} (mode 600). Open it in an editor and paste your keys.`)
}
