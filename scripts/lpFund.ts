/**
 * npm run lp:fund -- <sats> [lp url]: top up the liquidity agent's BSV inventory from YOUR wallet
 * (BSV Desktop, which asks you to approve). A BRC-29 payment to the agent's published identity key;
 * the agent verifies it by SPV before taking it. Default url http://127.0.0.1:8793 (npm run lp).
 */
import '../core/loadEnv'
import { WalletClient } from '@bsv/sdk'
import { createBrc29Payment } from '../client/payments'
import { LiquidityClient } from '../swap/lpClient'

const sats = Number(process.argv[2])
const url = process.argv[3] ?? process.env.LP_URL ?? 'http://127.0.0.1:8793'
if (!Number.isSafeInteger(sats) || sats <= 0) { console.error('usage: npm run lp:fund -- <sats> [lp url]'); process.exit(1) }
const lp = new LiquidityClient(url)
const info = await lp.info() as { bsvIdentityKey?: string | null, bsvSpendable?: number }
if (typeof info.bsvIdentityKey !== 'string') { console.error(`${url} publishes no BSV identity key`); process.exit(1) }
const wallet = new WalletClient('auto', 'cryptopledgepot.local')
console.log(`Paying ${sats.toLocaleString('en-US')} sats to the liquidity agent ${info.bsvIdentityKey.slice(0, 16)}… (approve in your wallet)`)
const r = await lp.fund(await createBrc29Payment(wallet, info.bsvIdentityKey, sats, 'Liquidity agent inventory', 'cryptopledgepot.local'))
console.log(`Done: tx ${r.txid}; the agent now holds ${r.spendable.toLocaleString('en-US')} spendable sats`)
