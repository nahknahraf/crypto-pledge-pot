/**
 * npm run keys:new: generate fresh TESTNET keys for the bridge into the secrets file, so nothing needs
 * pasting. Fills only EMPTY slots (never replaces a key you set), never prints a key, and prints the
 * addresses to fund. See docs/KEYS.md.
 *
 *   EVM (Base Sepolia): BRIDGE_DEPLOYER_KEY, BRIDGE_DONOR_KEY, BRIDGE_LP_KEY; LP_EVM_KEY = the same key as BRIDGE_LP_KEY
 *   Bitcoin (signet):   LP_BTC_KEY
 *
 * Never fund these with real money: they sit in a plain file, which is fine for testnets only.
 */
import '../core/loadEnv'
import fs from 'node:fs'
import { PrivateKey } from '@bsv/sdk'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import type { Hex } from 'viem'
import { btcPublicKey, p2wpkh, segwitAddress } from '../liquidity-agent/btc'
import { parseEnv } from '../core/loadEnv'
import { ensureSecretsFile, fillEmpty, secretsFile } from './secretsFile'

const file = secretsFile()
ensureSecretsFile(file)
const current = parseEnv(fs.readFileSync(file, 'utf8'))
const has = (k: string): boolean => (current[k] ?? '') !== ''
const lpKey = has('BRIDGE_LP_KEY') ? current.BRIDGE_LP_KEY : has('LP_EVM_KEY') ? current.LP_EVM_KEY : generatePrivateKey()
const set = fillEmpty({
  BRIDGE_CHAIN: 'base-sepolia',
  BRIDGE_DEPLOYER_KEY: generatePrivateKey(),
  BRIDGE_DONOR_KEY: generatePrivateKey(),
  BRIDGE_LP_KEY: lpKey,
  LP_EVM_KEY: lpKey,
  LP_BTC_KEY: PrivateKey.fromRandom().toHex()
}, file)
console.log(set.length > 0 ? `Generated into ${file}: ${set.join(', ')}` : `No empty key slots in ${file}; nothing generated.`)

const now = parseEnv(fs.readFileSync(file, 'utf8'))
const evm = (k: string): string | undefined => (now[k] ?? '') !== '' ? privateKeyToAccount(now[k] as Hex).address : undefined
console.log('\nAddresses to fund (TESTNET ONLY):')
for (const [k, what] of [['BRIDGE_DEPLOYER_KEY', 'Base Sepolia ETH, to deploy the HTLC'], ['BRIDGE_DONOR_KEY', 'Base Sepolia ETH + test USDC, the demo donor'], ['BRIDGE_LP_KEY', 'Base Sepolia ETH, the liquidity agent (receives USDC; also LP_EVM_KEY)']] as const) {
  const a = evm(k); if (a !== undefined) console.log(`  ${k.padEnd(20)} ${a}   ${what}`)
}
if ((now.LP_BTC_KEY ?? '') !== '') console.log(`  ${'LP_BTC_KEY'.padEnd(20)} ${segwitAddress(p2wpkh(btcPublicKey(PrivateKey.fromHex(now.LP_BTC_KEY))), 'test')}   signet: where the agent's claimed BTC lands (no funding needed)`)
