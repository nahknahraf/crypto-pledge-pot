/**
 * npm run lp: run the liquidity agent on its own.
 *
 * BSV side: its own wallet-toolbox wallet (data/lp.key, generated once) holding
 * the sats it sells. Other side: an ERC-20 HTLC on an EVM chain.
 *
 * Env:
 *   NETWORK=main|test          BSV network (default main)
 *   BRIDGE_CHAIN=base-sepolia|base|anvil   (default base-sepolia): an EVM source, needs
 *     BRIDGE_RPC_URL, BRIDGE_HTLC, BRIDGE_TOKEN   the EVM side (see npm run evm:deploy)
 *     LP_EVM_KEY                 0x… the agent's EVM key (receives the USDC; needs gas)
 *   BRIDGE_CHAIN=btc|btc-signet|btc-testnet|btc-regtest: a Bitcoin source, needs
 *     LP_BTC_KEY                 hex private key that receives the BTC (claims pay its P2WPKH)
 *     BTC_RPC_URL + BTC_RPC_USER + BTC_RPC_PASSWORD   your node (with -txindex), or else
 *     BTC_ESPLORA_URL            default https://mempool.space[/signet|/testnet]/api
 *     LP_SATS_PER_BTC (BSV sats per 1 BTC), LP_MAX_BTC=0.001; state in data/lp-swaps-btc.json
 *   BRIDGE_CHAIN=ln: Lightning via the agent's own LND node (hold invoices), needs
 *     LND_REST_URL (e.g. https://127.0.0.1:8080), LND_MACAROON_PATH (admin or invoices macaroon), LND_TLS_CERT_PATH
 *     LP_SATS_PER_BTC, LP_MAX_BTC; state in data/lp-swaps-ln.json
 *   LP_ROOT_KEY                else <LP_DATA_DIR>/lp.key (LP_DATA_DIR default data)
 *   LP_HOST=127.0.0.1 LP_PORT=8793 LP_INTERVAL_S=30
 *   LP_SATS_PER_USDC=21500 LP_MAX_USDC=20 LP_MIN_CONFIRMATIONS=3 (1 on anvil)
 *
 * Status: the same code runs offline in test/bridge.service.test.ts (Anvil +
 * mock chain). This entry point has NOT been run against a public network yet.
 * Keep LP_MAX_USDC small, and use testnets until the contract has been reviewed.
 */
import '../core/loadEnv'
import fs from 'node:fs'
import path from 'node:path'
import { PrivateKey, Transaction, Utils } from '@bsv/sdk'
import type { Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { anvil, base, baseSepolia } from 'viem/chains'
import { fileStore } from '../agent/ledger'
import { acquireLock } from '../agent/lock'
import { createToolboxWallet, loadOrCreateKey } from '../agent/wallet'
import { wocSpendSource } from '../server/watcher'
import type { SpendFinder } from './bsv'
import { btcPublicKey } from './btc'
import { BitcoindBackend, BitcoindRpc, BtcChain, EsploraBackend, type BtcBackend } from './btcChain'
import { EvmUsdcChain } from './evmChain'
import { LightningChain } from './lightningChain'
import { LndRest } from './lnd'
import { DEFAULT_LIQUIDITY, LiquidityAgent, type LpSwap } from './liquidityAgent'
import { createLiquidityApp } from './lpHttp'
import { USDC, type SourceChain } from './usdcChain'

const env = process.env
const need = (k: string): string => { const v = env[k] ?? ''; if (v === '') { console.error(`${k} is required`); process.exit(1) } return v }

const dataDir = env.LP_DATA_DIR ?? 'data' // one directory per agent: its key, wallet, swaps and lock
fs.mkdirSync(dataDir, { recursive: true })
const network = env.NETWORK === 'test' ? 'test' : 'main'
acquireLock(path.resolve(dataDir, 'lp.lock')) // one liquidity agent per state: two would lock sats twice
const btcNet = ({ btc: 'main', 'btc-signet': 'test', 'btc-testnet': 'test', 'btc-regtest': 'regtest' } as const)[env.BRIDGE_CHAIN ?? '']
let source: SourceChain, lpAddress: string, limits: { satsPerUnit: number, maxUnits: number, confirmations: number }, stateFile: string
if (env.BRIDGE_CHAIN === 'ln') {
  const node = new LndRest(need('LND_REST_URL'), fs.readFileSync(need('LND_MACAROON_PATH')).toString('hex'), fs.readFileSync(need('LND_TLS_CERT_PATH')))
  source = new LightningChain({ nodes: [node] })
  lpAddress = (await node.call<{ identity_pubkey: string }>('GET', '/v1/getinfo')).identity_pubkey
  limits = { satsPerUnit: Number(need('LP_SATS_PER_BTC')), maxUnits: Math.round(Number(env.LP_MAX_BTC ?? 0.001) * 1e8), confirmations: 1 } // a held payment reads as final; an unpaid invoice as 0 ("wait:")
  stateFile = 'lp-swaps-ln.json'
} else if (btcNet !== undefined) {
  const key = PrivateKey.fromHex(need('LP_BTC_KEY'))
  const esplora = env.BTC_ESPLORA_URL ?? `https://mempool.space${({ btc: '', 'btc-signet': '/signet', 'btc-testnet': '/testnet', 'btc-regtest': '' } as Record<string, string>)[env.BRIDGE_CHAIN!]}/api`
  const backend: BtcBackend = (env.BTC_RPC_URL ?? '') !== '' ? new BitcoindBackend(new BitcoindRpc(need('BTC_RPC_URL'), need('BTC_RPC_USER'), need('BTC_RPC_PASSWORD'))) : new EsploraBackend(esplora)
  source = new BtcChain({ backend, network: btcNet, signers: [key], name: `Bitcoin (${env.BRIDGE_CHAIN})` })
  lpAddress = btcPublicKey(key)
  limits = { satsPerUnit: Number(need('LP_SATS_PER_BTC')), maxUnits: Math.round(Number(env.LP_MAX_BTC ?? 0.001) * 1e8), confirmations: Number(env.LP_MIN_CONFIRMATIONS ?? (btcNet === 'regtest' ? 1 : 2)) }
  stateFile = 'lp-swaps-btc.json'
} else {
  const evmChain = env.BRIDGE_CHAIN === 'base' ? base : env.BRIDGE_CHAIN === 'anvil' ? anvil : baseSepolia
  const lpEvm = privateKeyToAccount(need('LP_EVM_KEY') as Hex)
  source = new EvmUsdcChain({ name: `USDC on ${evmChain.name}`, rpcUrl: need('BRIDGE_RPC_URL'), chain: evmChain, htlc: need('BRIDGE_HTLC') as Hex, token: need('BRIDGE_TOKEN') as Hex, signers: [lpEvm], confirmations: evmChain.id === anvil.id ? 1 : 2 })
  lpAddress = lpEvm.address
  limits = { satsPerUnit: Number(env.LP_SATS_PER_USDC ?? DEFAULT_LIQUIDITY.satsPerUsdc), maxUnits: Math.round(Number(env.LP_MAX_USDC ?? 20) * USDC), confirmations: Number(env.LP_MIN_CONFIRMATIONS ?? (evmChain.id === anvil.id ? 1 : 3)) }
  stateFile = 'lp-swaps.json'
}

const setup = await createToolboxWallet({ chain: network, rootKey: loadOrCreateKey('LP_ROOT_KEY', path.resolve(dataDir, 'lp.key')), dbFile: path.resolve(dataDir, 'lp-wallet.sqlite'), dbName: 'cryptopledgepot_lp' })
const spends = wocSpendSource(network)
const findSpend: SpendFinder = async (txid, vout) => {
  const by = await spends.spentBy(txid, vout)
  if (by === undefined) return undefined
  const bytes = Utils.toArray(await spends.beef(by), 'hex')
  try { return Transaction.fromAtomicBEEF(bytes) } catch { return Transaction.fromBEEF(bytes, by) }
}
const spendable = async (): Promise<number> => (await setup.wallet.listOutputs({ basket: 'default', limit: 1000 })).outputs.filter(o => o.spendable).reduce((s, o) => s + o.satoshis, 0)

const lp = new LiquidityAgent(setup.wallet, source, lpAddress, findSpend, spendable, {
  ...DEFAULT_LIQUIDITY,
  satsPerUsdc: limits.satsPerUnit,
  maxUsdc: limits.maxUnits,
  minSourceConfirmations: limits.confirmations
}, fileStore<LpSwap[]>(path.resolve(dataDir, stateFile), []))

const host = env.LP_HOST ?? '127.0.0.1'
const port = Number(env.LP_PORT ?? 8793)
createLiquidityApp(lp).listen(port, host, () => console.log(`[lp] BSV ${network} · ${source.name} · receives at ${lpAddress} · BSV identity ${setup.identityKey} · http://${host}:${port}/api/lp`))

let printed = 0
const tick = async (): Promise<void> => {
  try { await lp.step() } catch (e) { console.error(`[lp] step failed: ${(e as Error).message}`) }
  for (const line of lp.log.slice(printed)) console.log(`[lp] ${line}`)
  printed = lp.log.length
}
setInterval(() => { void tick() }, Number(env.LP_INTERVAL_S ?? 30) * 1000)
void tick()
