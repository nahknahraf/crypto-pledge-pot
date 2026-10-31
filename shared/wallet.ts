/**
 * wallet-toolbox wallets for the agent and the data provider (guide §14.1).
 * The root key comes from an env var or a generated, git-ignored key file
 * (mode 600). Keys are never logged.
 */
import fs from 'node:fs'
import path from 'node:path'
import { PrivateKey } from '@bsv/sdk'
import { Setup } from '@bsv/wallet-toolbox'

export type Chain = 'main' | 'test'

/**
 * A service's root key: from `envVar` if set to something non-empty, else from
 * `file` (generated once, mode 600). Anything that is not a valid 32-byte hex
 * key is refused: an empty or malformed value must never become a usable key.
 * (In Docker Compose an unset variable arrives as an EMPTY string.)
 */
export function loadOrCreateKey (envVar: string, file: string, log: (m: string) => void = console.log): PrivateKey {
  const parse = (hex: string, from: string): PrivateKey => {
    const h = hex.trim().toLowerCase()
    if (!/^[0-9a-f]{64}$/.test(h) || /^0+$/.test(h)) throw new Error(`${from} is not a valid private key (expected 64 hex characters)`)
    return PrivateKey.fromHex(h)
  }
  const fromEnv = process.env[envVar]
  if (fromEnv !== undefined && fromEnv.trim() !== '') return parse(fromEnv, envVar)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, PrivateKey.fromRandom().toHex().padStart(64, '0'), { mode: 0o600 })
    log(`Generated a new key in ${file} (set ${envVar} to override). Back it up.`)
  }
  return parse(fs.readFileSync(file, 'utf8'), file)
}

export async function createToolboxWallet (opts: { chain: Chain, rootKey: PrivateKey, dbFile: string, dbName: string }) {
  const identityKey = opts.rootKey.toPublicKey().toString()
  const env = { chain: opts.chain, identityKey, identityKey2: identityKey, taalApiKey: '', devKeys: {}, mySQLConnection: '{}' }
  const setup = await Setup.createWalletSQLite({ env: env as any, rootKeyHex: opts.rootKey.toHex(), filePath: opts.dbFile, databaseName: opts.dbName })
  startWalletMonitor(setup.monitor)
  return setup
}

/**
 * Run the wallet's monitor continuously (BSV_STACK_COMPLETE_GUIDE §14: "Run the monitor continuously in production").
 * It records merkle proofs once transactions are mined and retries broadcasts. Without it the wallet keeps every
 * transaction as unproven and, after ~12 chained payments, refuses to build more ("Maximum BEEF depth exceeded").
 */
export function startWalletMonitor (monitor: { addDefaultTasks: () => void, startTasks: () => Promise<void> }, log: (m: string) => void = console.error): void {
  // Setup.createWalletSQLite builds the monitor in 'default' mode, which already adds the default tasks; add them only if missing.
  if (((monitor as unknown as { _tasks?: unknown[] })._tasks ?? []).length === 0) monitor.addDefaultTasks()
  monitor.startTasks().catch(e => { log(`[wallet monitor] stopped: ${(e as Error).message}`) })
}
