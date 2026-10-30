/**
 * npm run lp: run the liquidity agent on its own.
 *
 * BSV side: its own wallet-toolbox wallet (data/lp.key, generated once) holding
 * the sats it sells. Other side: an ERC-20 HTLC on an EVM chain.
 *
 * Env:
 *   NETWORK=main|test          BSV network (default main)
 *   BRIDGE_CHAIN=base-sepolia|base|anvil   (default base-sepolia)
 *   BRIDGE_RPC_URL, BRIDGE_HTLC, BRIDGE_TOKEN   the EVM side (see npm run evm:deploy)
 *   LP_EVM_KEY                 0x… the agent's EVM key (receives the USDC; needs gas)
 *   LP_ROOT_KEY                else data/lp.key
 *   LP_HOST=127.0.0.1 LP_PORT=8793 LP_INTERVAL_S=30
 *   LP_SATS_PER_USDC=21500 LP_MAX_USDC=20
 *
 * Status: the same code runs offline in test/bridge.service.test.ts (Anvil +
 * mock chain). This entry point has NOT been run against a public network yet.
 * Keep LP_MAX_USDC small, and use testnets until the contract has been reviewed.
 */
import path from 'node:path'
import { Transaction, Utils } from '@bsv/sdk'
import type { Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { anvil, base, baseSepolia } from 'viem/chains'
import { fileStore } from '../agent/ledger'
import { createToolboxWallet, loadOrCreateKey } from '../agent/wallet'
import { wocSpendSource } from '../server/watcher'
import type { SpendFinder } from './bsv'
import { EvmUsdcChain } from './evmChain'
import { DEFAULT_LIQUIDITY, LiquidityAgent, type LpSwap } from './liquidityAgent'
import { createLiquidityApp } from './lpHttp'
import { USDC } from './usdcChain'

const env = process.env
const need = (k: string): string => { const v = env[k] ?? ''; if (v === '') { console.error(`${k} is required`); process.exit(1) } return v }

const network = env.NETWORK === 'test' ? 'test' : 'main'
const evmChain = env.BRIDGE_CHAIN === 'base' ? base : env.BRIDGE_CHAIN === 'anvil' ? anvil : baseSepolia
const lpEvm = privateKeyToAccount(need('LP_EVM_KEY') as Hex)
const evm = new EvmUsdcChain({ name: `USDC on ${evmChain.name}`, rpcUrl: need('BRIDGE_RPC_URL'), chain: evmChain, htlc: need('BRIDGE_HTLC') as Hex, token: need('BRIDGE_TOKEN') as Hex, signers: [lpEvm], confirmations: evmChain.id === anvil.id ? 1 : 2 })

const setup = await createToolboxWallet({ chain: network, rootKey: loadOrCreateKey('LP_ROOT_KEY', path.resolve('data', 'lp.key')), dbFile: path.resolve('data', 'lp-wallet.sqlite'), dbName: 'cryptopledgepot_lp' })
const spends = wocSpendSource(network)
const findSpend: SpendFinder = async (txid, vout) => {
  const by = await spends.spentBy(txid, vout)
  if (by === undefined) return undefined
  const bytes = Utils.toArray(await spends.beef(by), 'hex')
  try { return Transaction.fromAtomicBEEF(bytes) } catch { return Transaction.fromBEEF(bytes, by) }
}
const spendable = async (): Promise<number> => (await setup.wallet.listOutputs({ basket: 'default', limit: 1000 })).outputs.filter(o => o.spendable).reduce((s, o) => s + o.satoshis, 0)

const lp = new LiquidityAgent(setup.wallet, evm, lpEvm.address, findSpend, spendable, {
  ...DEFAULT_LIQUIDITY,
  satsPerUsdc: Number(env.LP_SATS_PER_USDC ?? DEFAULT_LIQUIDITY.satsPerUsdc),
  maxUsdc: Math.round(Number(env.LP_MAX_USDC ?? 20) * USDC)
}, fileStore<LpSwap[]>(path.resolve('data', 'lp-swaps.json'), []))

const host = env.LP_HOST ?? '127.0.0.1'
const port = Number(env.LP_PORT ?? 8793)
createLiquidityApp(lp).listen(port, host, () => console.log(`[lp] BSV ${network} · ${evm.name} · EVM ${lpEvm.address} · BSV identity ${setup.identityKey} · http://${host}:${port}/api/lp`))

let printed = 0
const tick = async (): Promise<void> => {
  try { await lp.step() } catch (e) { console.error(`[lp] step failed: ${(e as Error).message}`) }
  for (const line of lp.log.slice(printed)) console.log(`[lp] ${line}`)
  printed = lp.log.length
}
setInterval(() => { void tick() }, Number(env.LP_INTERVAL_S ?? 30) * 1000)
void tick()
