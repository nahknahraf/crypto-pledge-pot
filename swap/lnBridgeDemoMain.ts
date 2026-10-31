/**
 * npm run demo:bridge:ln: Lightning → BSV sats, atomically, with real LND nodes (regtest).
 *
 * Starts a throwaway regtest bitcoind and two LND nodes (the donor's and the agent's) with a channel,
 * then: the agent issues a hold invoice under the donor's hashlock → the donor checks and pays it
 * (held, not settled) → the agent locks BSV sats for the donor → the donor claims them (revealing the
 * secret) → the agent settles the invoice with it. Needs bitcoind and lnd (BITCOIND_BIN, LND_BIN).
 * The BSV side is the offline mock chain.
 */
import '../core/loadEnv'
import { Transaction } from '@bsv/sdk'
import type { Wallet } from '@bsv/wallet-toolbox'
import { createMockChain } from '../test/helpers/mockchain'
import { startRegtest } from './bitcoind'
import type { SpendFinder } from './bsv'
import { DonorSwap } from './donorSwap'
import { LightningChain } from './lightningChain'
import { DEFAULT_LIQUIDITY, LiquidityAgent } from './liquidityAgent'
import { openChannel, startLnd, waitFor } from './lnd'

const pace = Number(process.env.DEMO_PACE_S ?? 1) * 1000
const say = async (line: string): Promise<void> => { console.log(line); await new Promise(r => setTimeout(r, pace)) }

const btc = await startRegtest({ zmq: true })
const [donor, agentNode] = await Promise.all([startLnd(btc, 'donor'), startLnd(btc, 'agent')])
const chain = await createMockChain()
try {
  await say(`Regtest bitcoind and two LND nodes up: donor ${donor.pubkey.slice(0, 16)}…, agent ${agentNode.pubkey.slice(0, 16)}…`)
  await openChannel(btc, donor, agentNode, 500_000)
  await say('The donor opened a 500,000-sat channel to the agent')
  const donorLn = new LightningChain({ nodes: [donor.rest] }); const agentLn = new LightningChain({ nodes: [agentNode.rest] })
  const spendable = async (w: Wallet): Promise<number> => (await w.listOutputs({ basket: 'default', limit: 1000 })).outputs.filter(o => o.spendable).reduce((s, o) => s + o.satoshis, 0)
  const findSpend: SpendFinder = async (txid, vout) => {
    const storage = (chain.services as any).storage
    const row = await storage.knex('mockchain_utxos').where({ txid, vout }).first()
    return row?.spentByTxid == null ? undefined : Transaction.fromBinary(Array.from((await storage.getTransaction(row.spentByTxid)).rawTx as number[]))
  }
  const lpWallet = await chain.makeWallet(); await chain.fund(lpWallet, 50_000_000)
  const lp = new LiquidityAgent(lpWallet, agentLn, agentNode.pubkey, findSpend, async () => await spendable(lpWallet), { ...DEFAULT_LIQUIDITY, satsPerUsdc: 200_000_000_000, maxUsdc: 1_000_000 })
  const donorWallet = await chain.makeWallet()
  const swap = new DonorSwap(donorWallet, donorLn, donor.pubkey, chain.chainTracker)

  let r = await swap.requestQuote(lp, 10_000)
  await say(`1. ${r.steps[0]}`)
  r = await swap.lockAndRequest(lp, r)
  await say('2. the agent issued a hold invoice under the donor\'s hashlock; the donor checked it and paid. The payment is HELD, not settled')
  await waitFor(async () => (await agentLn.htlc(r.hashlock))?.amount === 10_000, 'the held payment')
  if (r.lock === undefined) r = await swap.requestLock(lp, r)
  await say(`3. the agent saw the held payment and locked ${r.lock!.satoshis.toLocaleString('en-US')} sats on BSV for the donor`)
  await say(`4. the donor checks that lock on chain: ${(await swap.verifyLock(r)).join('; ') || 'OK'}`)
  r = await swap.claim(r)
  await say(`5. the donor claimed the sats: their own BSV wallet now holds ${(await spendable(donorWallet)).toLocaleString('en-US')} sats`)
  await lp.step()
  await waitFor(async () => (await donorLn.htlc(r.hashlock))?.state === 'claimed', 'the payment to settle')
  for (const line of lp.log) console.log(`   [liquidity agent] ${line}`)
  await say(`6. the agent settled the invoice with the secret from the BSV claim; its channel balance: ${await agentLn.account(agentNode.pubkey).balance()} sats`)
  console.log('\nDone. Lightning ran on two real LND nodes (regtest); the BSV side ran on the offline mock chain.')
} finally {
  await chain.close(); await donor.stop(); await agentNode.stop(); await btc.stop()
}
process.exit(0)
