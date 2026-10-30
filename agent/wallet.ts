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

export function loadOrCreateKey (envVar: string, file: string): PrivateKey {
  const fromEnv = process.env[envVar]
  if (fromEnv !== undefined && fromEnv !== '') return PrivateKey.fromHex(fromEnv)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, PrivateKey.fromRandom().toHex(), { mode: 0o600 })
    console.log(`Generated a new key in ${file} (set ${envVar} to override). Back it up.`)
  }
  return PrivateKey.fromHex(fs.readFileSync(file, 'utf8').trim())
}

export async function createToolboxWallet (opts: { chain: Chain, rootKey: PrivateKey, dbFile: string, dbName: string }) {
  const identityKey = opts.rootKey.toPublicKey().toString()
  const env = { chain: opts.chain, identityKey, identityKey2: identityKey, taalApiKey: '', devKeys: {}, mySQLConnection: '{}' }
  const setup = await Setup.createWalletSQLite({ env: env as any, rootKeyHex: opts.rootKey.toHex(), filePath: opts.dbFile, databaseName: opts.dbName })
  return setup
}
