/**
 * CryptoPledgePot server (indexer + arbiter) for mainnet/testnet.
 *
 * Env:
 *   CRYPTOPLEDGEPOT_ARBITER_KEY   64 hex chars, the arbiter's root key. Generated into
 *                         data/arbiter.key on first run if unset. Keep it secret
 *                         and backed up: it is the vote oracle's signing key.
 *   NETWORK               main (default) | test
 *   PORT                  8787
 *   CRYPTOPLEDGEPOT_DB            ./data/cryptopledgepot.db
 *   ARBITER_WALLET_DB     ./data/arbiter-wallet.sqlite
 *
 * The arbiter wallet is a full wallet-toolbox wallet. It never needs funds:
 * it only derives keys, signs sighashes and authenticates the API (BRC-103).
 */
import fs from 'node:fs'
import path from 'node:path'
import { PrivateKey } from '@bsv/sdk'
import { Setup } from '@bsv/wallet-toolbox'
import { ArcadeChainTracker, ARCADE_MAINNET, ARCADE_TESTNET } from '../client/arcadeChainTracker'
import { createCryptoPledgePotApp } from './app'
import { CryptoPledgePotDb, sqliteKnex } from './db'

const chain = process.env.NETWORK === 'test' ? 'test' : 'main'
const port = Number(process.env.PORT ?? 8787)
const dataDir = path.resolve('data')
fs.mkdirSync(dataDir, { recursive: true })

function arbiterKey (): PrivateKey {
  if (process.env.CRYPTOPLEDGEPOT_ARBITER_KEY !== undefined) return PrivateKey.fromHex(process.env.CRYPTOPLEDGEPOT_ARBITER_KEY)
  const file = path.join(dataDir, 'arbiter.key')
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, PrivateKey.fromRandom().toHex(), { mode: 0o600 })
    console.log(`Generated a new arbiter key in ${file}. Back it up.`)
  }
  return PrivateKey.fromHex(fs.readFileSync(file, 'utf8').trim())
}

async function main (): Promise<void> {
  const rootKey = arbiterKey()
  const identityKey = rootKey.toPublicKey().toString()
  const env = { chain, identityKey, identityKey2: identityKey, taalApiKey: '', devKeys: {}, mySQLConnection: '{}' } as const
  const setup = await Setup.createWalletSQLite({
    env: env as any,
    rootKeyHex: rootKey.toHex(),
    filePath: process.env.ARBITER_WALLET_DB ?? path.join(dataDir, 'arbiter-wallet.sqlite'),
    databaseName: 'cryptopledgepot_arbiter'
  })

  const db = new CryptoPledgePotDb(sqliteKnex(process.env.CRYPTOPLEDGEPOT_DB ?? path.join(dataDir, 'cryptopledgepot.db')))
  await db.migrate()

  const app = createCryptoPledgePotApp({
    wallet: setup.wallet,
    db,
    chainTracker: new ArcadeChainTracker(chain === 'main' ? ARCADE_MAINNET : ARCADE_TESTNET)
  })
  app.listen(port, () => {
    console.log(`CryptoPledgePot indexer + arbiter on http://localhost:${port} (${chain}net)`)
    console.log(`Arbiter identity key: ${setup.identityKey}`)
  })
}

main().catch(e => { console.error(e); process.exit(1) })
