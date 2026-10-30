/**
 * "Fay has only USDC", with a REAL other chain: the happy path of the bridge.
 *
 * Other side: a Solidity ERC-20 HTLC on an EVM chain through viem. By default
 * a local Anvil chain with a 6-decimal test USDC; with BRIDGE_RPC_URL it uses
 * a public chain (Base Sepolia) and real test USDC instead (see bridgeDemoMain).
 * BSV side: real wallets on the offline mock chain, as in demo:swap.
 */
import type { Server } from 'node:http'
import { Transaction } from '@bsv/sdk'
import type { Wallet } from '@bsv/wallet-toolbox'
import type { Account, Address, Chain } from 'viem'
import { anvil as anvilChain } from 'viem/chains'
import { CryptoPledgePot } from '../client/cryptoPledgePot'
import { CryptoPledgePotApi } from '../client/cryptoPledgePotApi'
import { createCryptoPledgePotApp } from '../server/app'
import { CryptoPledgePotDb } from '../server/db'
import { createMockChain, memoryKnex } from '../test/helpers/mockchain'
import { anvilAccount, startAnvil, type Anvil } from './anvil'
import type { SpendFinder } from './bsv'
import { DonorSwap } from './donorSwap'
import { deployBridgeContracts, EvmUsdcChain, mintTestUsdc } from './evmChain'
import { LiquidityAgent } from './liquidityAgent'
import { formatUsdc, USDC } from './usdcChain'

export interface PublicEvm {
  name: string
  rpcUrl: string
  chain: Chain
  htlc: Address
  token: Address
  donor: Account
  lp: Account
  confirmations: number
  explorer?: string
}

export interface BridgeDemoResult { usdcLocked: number, satsReceived: number, lpUsdc: number, pledged: number, htlcId: string, secretPublicOnEvm: boolean }

export async function runBridgeDemo (opts: { paceMs?: number, log?: (line: string) => void, usdc?: number, publicEvm?: PublicEvm } = {}): Promise<BridgeDemoResult> {
  const say = opts.log ?? ((l: string) => console.log(l))
  const pace = async (): Promise<void> => { if ((opts.paceMs ?? 0) > 0) await new Promise(r => setTimeout(r, opts.paceMs)) }
  const sats = (n: number): string => `${n.toLocaleString('en-US')} sats`
  const amount = opts.usdc ?? 100 * USDC

  // The other chain: local Anvil (contracts deployed fresh, test USDC minted), or a public chain from env.
  let node: Anvil | undefined
  let evm: EvmUsdcChain, donorAddr: Address, lpAddr: Address
  if (opts.publicEvm === undefined) {
    node = await startAnvil()
    const deployer = anvilAccount(0); const donor = anvilAccount(1); const lpAcc = anvilAccount(2)
    const { htlc, token } = await deployBridgeContracts(node.rpcUrl, anvilChain, deployer, { withTestToken: true })
    await mintTestUsdc(node.rpcUrl, anvilChain, deployer, token!, donor.address, amount)
    evm = new EvmUsdcChain({ name: 'USDC on a local EVM chain (Anvil)', rpcUrl: node.rpcUrl, chain: anvilChain, htlc, token: token!, signers: [donor, lpAcc] })
    donorAddr = donor.address; lpAddr = lpAcc.address
  } else {
    const p = opts.publicEvm
    evm = new EvmUsdcChain({ name: p.name, rpcUrl: p.rpcUrl, chain: p.chain, htlc: p.htlc, token: p.token, signers: [p.donor, p.lp], confirmations: p.confirmations })
    donorAddr = p.donor.address; lpAddr = p.lp.address
  }

  const chain = await createMockChain()
  const spendable = async (w: Wallet): Promise<number> => (await w.listOutputs({ basket: 'default', limit: 1000 })).outputs.filter(o => o.spendable).reduce((s, o) => s + o.satoshis, 0)
  const findSpend: SpendFinder = async (txid, vout) => {
    const storage = (chain.services as any).storage
    const row = await storage.knex('mockchain_utxos').where({ txid, vout }).first()
    return row?.spentByTxid == null ? undefined : Transaction.fromBinary(Array.from((await storage.getTransaction(row.spentByTxid)).rawTx as number[]))
  }
  const clock = await evm.now()
  const db = new CryptoPledgePotDb(memoryKnex()); await db.migrate()
  const arbiter = await chain.makeWallet()
  const server: Server = await new Promise(resolve => { const s = createCryptoPledgePotApp({ wallet: arbiter, db, chainTracker: chain.chainTracker, now: () => clock }).listen(0, () => resolve(s)) })
  const url = `http://127.0.0.1:${(server.address() as any).port}`

  try {
    const creator = await chain.makeWallet(); await chain.fund(creator, 50_000)
    const { meta } = await new CryptoPledgePot(creator, new CryptoPledgePotApi(url, creator)).launch({
      title: 'Clean water for Kitui', description: 'One well with a hand pump; water test results published for every milestone.', goal: 1_500_000,
      deadline: clock + 7 * 86_400, refundAfter: clock + 40 * 86_400, milestones: [{ title: 'Drill the well', percent: 60 }, { title: 'Publish water tests', percent: 40 }]
    })
    const lpWallet = await chain.makeWallet(); await chain.fund(lpWallet, 5_000_000)
    const lp = new LiquidityAgent(lpWallet, evm, lpAddr, findSpend, async () => await spendable(lpWallet))
    const fay = await chain.makeWallet()
    const faySwap = new DonorSwap(fay, evm, donorAddr, chain.chainTracker)
    const balances = async (): Promise<string> =>
      `      Fay: ${formatUsdc(await evm.account(donorAddr).balance())} · ${sats(await spendable(fay))}    LP: ${formatUsdc(await evm.account(lpAddr).balance())} · ${sats(await spendable(lpWallet))}`

    say('THE BRIDGE: Fay holds USDC on an EVM chain, and wants to back "Clean water for Kitui" on BSV')
    say(`  (other chain: ${evm.name}, HTLC contract ${evm.opts.htlc} · BSV: real wallets on the offline mock chain)`)
    say(await balances())
    await pace()
    let r = await faySwap.requestQuote(lp, amount)
    say(`  1. Quote: ${formatUsdc(r.quote.usdc)} → ${sats(r.quote.sats)}, paid to a fresh key in Fay's own BSV wallet`)
    await pace()
    r = await faySwap.lockAndRequest(lp, r)
    if (r.lock === undefined) throw new Error(r.steps.at(-1))
    say(`  2. Fay's EVM account calls lock() on the HTLC contract: ${formatUsdc(r.quote.usdc)} for the LP under sha256(secret). Lock id ${r.sourceHtlcId!.slice(0, 16)}…`)
    say(`  3. The LP reads that lock from the EVM contract, then locks ${sats(r.lock.satoshis)} on BSV for Fay's key, with an earlier timeout`)
    say(await balances())
    await pace()
    const problems = await faySwap.verifyLock(r)
    say(`  4. Fay's agent checks the BSV lock: ${problems.length === 0 ? 'SPV, same hash, her key, full amount, safe timeout → all good' : problems.join('; ')}`)
    r = await faySwap.claim(r)
    if (r.state !== 'claimed') throw new Error(r.steps.at(-1))
    say(`  5. Fay claims the sats into HER OWN wallet; the claim reveals the secret on BSV`)
    await pace()
    await lp.step()
    const h = await evm.htlc(r.sourceHtlcId!)
    say(`  6. The LP reads the secret from BSV and calls claim() on the EVM contract: ${formatUsdc(h!.amount)} collected. The secret is now public in the Claimed event too`)
    say(await balances())
    await pace()
    const pledge = await new CryptoPledgePot(fay, new CryptoPledgePotApi(url, fay)).donate(meta, 1_000_000, { name: 'Fay', message: 'Came over from USDC' })
    say(`  7. Fay backs "${meta.title}" with ${sats(pledge.amount)}, in milestone escrow like everyone else`)
    say(await balances())
    return { usdcLocked: r.quote.usdc, satsReceived: r.lock!.satoshis, lpUsdc: await evm.account(lpAddr).balance(), pledged: pledge.amount, htlcId: r.sourceHtlcId!, secretPublicOnEvm: h?.secret === r.secret }
  } finally {
    await new Promise(resolve => server.close(resolve))
    await chain.close()
    await node?.stop()
  }
}
