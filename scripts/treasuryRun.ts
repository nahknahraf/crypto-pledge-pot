/**
 * The team treasury, run once: show a deposit address, wait for the team's deposit, claim it (SPV), fund every
 * agent (scripts/zeroClick.ts), and record that it did, so a restart never pays twice.
 * State in data/treasury/: treasury.key (or TREASURY_ROOT_KEY), the wallet DB, deposit.json, claimed.json, funded.json.
 */
import path from 'node:path'
import { Utils } from '@bsv/sdk'
import { ArcadeChainTracker, ARCADE_MAINNET, ARCADE_TESTNET } from '../client/arcadeChainTracker'
import { wocBeef } from '../client/cryptoPledgePot'
import { newReceiveAddress, type ReceiveAddress } from '../client/receive'
import { fundStore } from './treasuryStore'
import { claimDeposits, fundAgents, type FundResult } from '../shared/treasury'
import { createToolboxWallet, loadOrCreateKey } from '../shared/wallet'
import { depositNeeded, fundTargets, totalFunding } from './zeroClick'

export async function runTreasury (o: { network: 'main' | 'test', log?: (m: string) => void, pollMs?: number }): Promise<FundResult[] | 'already funded'> {
  const log = o.log ?? (m => console.log(`[treasury] ${m}`))
  const dir = path.resolve(process.env.CPP_DATA_DIR ?? 'data', 'treasury')
  const store = fundStore(dir)
  const done = new Set(store.funded().map(r => r.name))
  const targets = fundTargets().filter(t => !done.has(t.name))
  if (targets.length === 0) { log(`every agent is already funded (${path.join(dir, 'funded.json')})`); return 'already funded' }
  const needed = targets.reduce((s, t) => s + t.sats, 0) + (depositNeeded() - totalFunding())
  const setup = await createToolboxWallet({ chain: o.network, rootKey: loadOrCreateKey('TREASURY_ROOT_KEY', path.join(dir, 'treasury.key')), dbFile: path.join(dir, 'treasury-wallet.sqlite'), dbName: 'cryptopledgepot_treasury' })
  const wallet = setup.wallet
  let address: ReceiveAddress | undefined = store.deposit()
  if (address === undefined) { address = await newReceiveAddress(wallet, o.network); store.saveDeposit(address) }
  const spendable = async (): Promise<number> => (await wallet.listOutputs({ basket: 'default', limit: 1000 })).outputs.filter(x => x.spendable).reduce((s, x) => s + x.satoshis, 0)
  const chainTracker = new ArcadeChainTracker(o.network === 'main' ? ARCADE_MAINNET : ARCADE_TESTNET)
  log(`send at least ${needed.toLocaleString('en-US')} sats (minus what the treasury already holds) to ${address.address} (BSV ${o.network}net), from any wallet or exchange. One payment funds every agent.`)
  for (;;) {
    try {
      const got = await claimDeposits(wallet, address, store.claimed(), { network: o.network, chainTracker, fetchBeef: async txid => Utils.toArray(await wocBeef(txid, o.network), 'hex') })
      for (const g of got) { store.addClaimed(g.txid); log(`claimed ${g.sats.toLocaleString('en-US')} sats (tx ${g.txid.slice(0, 12)}…, verified by SPV)`) }
    } catch (e) { log(`checking the deposit address: ${(e as Error).message} (will retry)`) }
    const have = await spendable()
    if (have >= needed) break
    await new Promise(r => setTimeout(r, o.pollMs ?? 30_000))
  }
  log(`funding ${targets.length} agent(s) with ${targets.reduce((s, t) => s + t.sats, 0).toLocaleString('en-US')} sats…`)
  const results = await fundAgents(wallet, targets, { log })
  store.addFunded(results)
  if (!results.every(r => r.ok)) log('some agents could not be funded (see above). Run `npm run agents:fund` again once they are up: only the unfunded ones are paid.')
  return results
}
