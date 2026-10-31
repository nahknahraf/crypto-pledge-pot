/**
 * npm run demo:bridge:btc: BTC → BSV sats, atomically, on a real Bitcoin Core node (regtest).
 *
 * Starts a throwaway regtest node (swap/bitcoind.ts; needs bitcoind, see BITCOIND_BIN), then:
 * the donor locks 0.0001 BTC in a P2WSH HTLC from their Bitcoin wallet → the liquidity agent waits
 * for a confirmation and locks BSV sats for the donor → the donor checks and claims them (revealing
 * the secret) → the agent claims the BTC with that secret. The BSV side is the offline mock chain.
 */
import '../core/loadEnv'
import { PrivateKey, Transaction } from '@bsv/sdk'
import type { Wallet } from '@bsv/wallet-toolbox'
import { createMockChain } from '../test/helpers/mockchain'
import { startRegtest } from './bitcoind'
import { btcPublicKey } from './btc'
import { BitcoindBackend, bitcoindWalletFunder, BtcChain } from './btcChain'
import type { SpendFinder } from './bsv'
import { DonorSwap } from './donorSwap'
import { DEFAULT_LIQUIDITY, LiquidityAgent } from './liquidityAgent'

const pace = Number(process.env.DEMO_PACE_S ?? 1) * 1000
const say = async (line: string): Promise<void> => { console.log(line); await new Promise(r => setTimeout(r, pace)) }

const node = await startRegtest()
const chain = await createMockChain()
try {
  const donorBtc = PrivateKey.fromRandom(); const lpBtc = PrivateKey.fromRandom()
  const btc = new BtcChain({ backend: new BitcoindBackend(node.rpc), network: 'regtest', signers: [donorBtc, lpBtc], funder: bitcoindWalletFunder(node.rpc, node.wallet) })
  const spendable = async (w: Wallet): Promise<number> => (await w.listOutputs({ basket: 'default', limit: 1000 })).outputs.filter(o => o.spendable).reduce((s, o) => s + o.satoshis, 0)
  const findSpend: SpendFinder = async (txid, vout) => {
    const storage = (chain.services as any).storage
    const row = await storage.knex('mockchain_utxos').where({ txid, vout }).first()
    return row?.spentByTxid == null ? undefined : Transaction.fromBinary(Array.from((await storage.getTransaction(row.spentByTxid)).rawTx as number[]))
  }
  const lpWallet = await chain.makeWallet(); await chain.fund(lpWallet, 50_000_000)
  const lp = new LiquidityAgent(lpWallet, btc, btcPublicKey(lpBtc), findSpend, async () => await spendable(lpWallet), { ...DEFAULT_LIQUIDITY, satsPerUsdc: 200_000_000_000, maxUsdc: 1e8 })
  const donorWallet = await chain.makeWallet()
  const swap = new DonorSwap(donorWallet, btc, btcPublicKey(donorBtc), chain.chainTracker)

  await say(`Bitcoin Core regtest node up (${(await node.rpc.call('getnetworkinfo')).subversion}); the donor's Bitcoin wallet holds ${await node.rpc.call('getbalance', [], node.wallet)} BTC`)
  let r = await swap.requestQuote(lp, 10_000)
  await say(`1. ${r.steps[0]}`)
  r = await swap.lockAndRequest(lp, r)
  await say(`2. the donor locked 0.0001 BTC in an HTLC: tx ${r.sourceHtlcId!.split(':')[0]}`)
  await say(`   the agent answered: ${r.steps.at(-1)}`)
  await node.mine(1)
  r = await swap.requestLock(lp, r)
  await say(`3. one block later the agent locked ${r.lock!.satoshis.toLocaleString('en-US')} sats on BSV for the donor (tx ${r.lock!.txid.slice(0, 16)}…)`)
  const problems = await swap.verifyLock(r)
  await say(`4. the donor checks that lock on chain: ${problems.length === 0 ? 'OK' : problems.join('; ')}`)
  r = await swap.claim(r)
  await say(`5. the donor claimed the sats: their own BSV wallet now holds ${(await spendable(donorWallet)).toLocaleString('en-US')} sats`)
  await lp.step()
  await node.mine(1)
  for (const line of lp.log) console.log(`   [liquidity agent] ${line}`)
  const h = await btc.htlc(r.sourceHtlcId!)
  await say(`6. the agent read the secret from the BSV claim and claimed the BTC (HTLC ${h!.state}); its Bitcoin key now holds ${await btc.account(btcPublicKey(lpBtc)).balance()} BTC sats after the miner fee`)
  console.log('\nDone. Bitcoin was a real Bitcoin Core node (regtest); the BSV side ran on the offline mock chain.')
} finally {
  await chain.close(); await node.stop()
}
process.exit(0)
