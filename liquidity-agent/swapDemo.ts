/**
 * "Fay has only USDC": the cross-chain swap as a narrated, offline demo.
 *
 * BSV side: real wallets on wallet-toolbox's mock chain; the sCrypt AtomicSwap
 * and the escrow are validated by the chain. Other side: the SIMULATED USDC
 * HTLC ledger (no local EVM here). Act 1 is the happy path into a campaign
 * pledge; act 2 shows a cheating liquidity provider getting nothing.
 */
import type { Server } from 'node:http'
import { Transaction } from '@bsv/sdk'
import type { Wallet } from '@bsv/wallet-toolbox'
import { CryptoPledgePot } from '../client/cryptoPledgePot'
import { CryptoPledgePotApi } from '../client/cryptoPledgePotApi'
import { createCryptoPledgePotApp } from '../server/app'
import { CryptoPledgePotDb } from '../server/db'
import { createMockChain, memoryKnex } from '../test/helpers/mockchain'
import type { SpendFinder } from './bsv'
import { DonorSwap } from './donorSwap'
import { LiquidityAgent, type Quote } from './liquidityAgent'

/** Act 2's villain: quotes like everyone else, then locks 100,000 sats less than it promised. */
class ShortchangingAgent extends LiquidityAgent {
  protected override lockedAmount (quote: Quote): number { return quote.sats - 100_000 }
}
import { formatUsdc, SimulatedUsdcChain, USDC } from './usdcChain'

export interface SwapDemoResult {
  happy: { usdcPaid: number, satsReceived: number, lpUsdc: number, pledged: number, campaignTitle: string, secretRevealedOnBsv: boolean }
  cheat: { refused: boolean, reason: string, usdcBack: number }
}

export async function runSwapDemo (opts: { paceMs?: number, log?: (line: string) => void } = {}): Promise<SwapDemoResult> {
  const say = opts.log ?? ((l: string) => console.log(l))
  const pace = async (): Promise<void> => { if ((opts.paceMs ?? 0) > 0) await new Promise(r => setTimeout(r, opts.paceMs)) }
  const sats = (n: number): string => `${n.toLocaleString('en-US')} sats`

  let clock = Math.floor(Date.now() / 1000) - 30 * 86_400
  const chain = await createMockChain()
  const usdc = new SimulatedUsdcChain(() => clock)
  const spendable = async (w: Wallet): Promise<number> => (await w.listOutputs({ basket: 'default', limit: 1000 })).outputs.filter(o => o.spendable).reduce((s, o) => s + o.satoshis, 0)
  const findSpend: SpendFinder = async (txid, vout) => {
    const storage = (chain.services as any).storage
    const row = await storage.knex('mockchain_utxos').where({ txid, vout }).first()
    return row?.spentByTxid == null ? undefined : Transaction.fromBinary(Array.from((await storage.getTransaction(row.spentByTxid)).rawTx as number[]))
  }

  // The world: a CryptoPledgePot server with one campaign, a liquidity agent, and Fay.
  const db = new CryptoPledgePotDb(memoryKnex()); await db.migrate()
  const arbiter = await chain.makeWallet()
  const server: Server = await new Promise(resolve => { const s = createCryptoPledgePotApp({ wallet: arbiter, db, chainTracker: chain.chainTracker, now: () => clock }).listen(0, () => resolve(s)) })
  const url = `http://127.0.0.1:${(server.address() as any).port}`
  const creator = await chain.makeWallet(); await chain.fund(creator, 50_000)
  const { meta } = await new CryptoPledgePot(creator, new CryptoPledgePotApi(url, creator)).launch({
    title: 'Clean water for Kitui', description: 'One well with a hand pump; water test results published for every milestone.', goal: 1_500_000,
    deadline: clock + 7 * 86_400, refundAfter: clock + 40 * 86_400, milestones: [{ title: 'Drill the well', percent: 60 }, { title: 'Publish water tests', percent: 40 }]
  })
  const lpWallet = await chain.makeWallet(); await chain.fund(lpWallet, 5_000_000)
  const lp = new LiquidityAgent(lpWallet, usdc, '0xLiquidityAgent', findSpend, async () => await spendable(lpWallet))
  const fay = await chain.makeWallet()
  usdc.mint('0xFay', 100 * USDC)
  const faySwap = new DonorSwap(fay, usdc, '0xFay', chain.chainTracker)
  const balances = async (): Promise<string> =>
    `      Fay: ${formatUsdc(await usdc.account('0xFay').balance())} · ${sats(await spendable(fay))}    LP: ${formatUsdc(await usdc.account('0xLiquidityAgent').balance())} · ${sats(await spendable(lpWallet))}`

  try {
    say('ACT 1: Fay has only USDC, and wants to back "Clean water for Kitui" on BSV')
    say(`  (BSV: real wallets on the offline mock chain · ${usdc.name})`)
    say(await balances())
    await pace()

    let r = await faySwap.requestQuote(lp, 100 * USDC)
    say(`  1. Fay's agent asks a liquidity agent for a price: ${formatUsdc(r.quote.usdc)} → ${sats(r.quote.sats)}, paid to a fresh key in Fay's own wallet`)
    await pace()
    say(`  2. Fay's agent makes a secret and keeps it; only its hash goes anywhere: ${r.hashlock.slice(0, 16)}…`)
    await pace()
    r = await faySwap.lockAndRequest(lp, r)
    const t1 = (await usdc.htlc(r.sourceHtlcId!))!.refundAfter
    say(`  3. Fay locks ${formatUsdc(r.quote.usdc)} for the LP, claimable only with the secret, refundable to Fay after ${Math.round((t1 - clock) / 3600)} h`)
    say(`  4. The LP checks that lock ON THE OTHER CHAIN, then locks ${sats(r.lock!.satoshis)} on BSV for Fay's key, refundable to the LP after ${Math.round((r.lock!.terms.refundAfter - clock) / 3600)} h (earlier than Fay's, so Fay can always claim first)`)
    say(await balances())
    await pace()
    const problems = await faySwap.verifyLock(r)
    say(`  5. Fay's agent checks the BSV lock itself: SPV, same hash, pays Fay's key, full amount, safe timeout → ${problems.length === 0 ? 'all good' : problems.join('; ')}`)
    await pace()
    r = await faySwap.claim(r)
    say(`  6. Fay claims: ${sats(r.lock!.satoshis)} move into HER OWN wallet (minus a tiny fee). The claim reveals the secret on BSV`)
    await pace()
    await lp.step()
    const htlc = await usdc.htlc(r.sourceHtlcId!)
    say(`  7. The LP reads the secret from Fay's BSV claim and collects ${formatUsdc(htlc!.amount)}. Swap complete: nobody ever held the other's money`)
    say(await balances())
    await pace()
    const pledgeSats = 1_000_000
    const pledge = await new CryptoPledgePot(fay, new CryptoPledgePotApi(url, fay)).donate(meta, pledgeSats, { name: 'Fay', message: 'Came over from USDC' })
    say(`  8. Fay backs "${meta.title}" with ${sats(pledge.amount)}, in milestone escrow like everyone else`)
    say(await balances())
    await pace()

    say('')
    say('ACT 2: …and if the liquidity provider cheats?')
    usdc.mint('0xFay', 10 * USDC)
    const shadyWallet = await chain.makeWallet(); await chain.fund(shadyWallet, 1_000_000)
    const shady = new ShortchangingAgent(shadyWallet, usdc, '0xShadyLP', findSpend, async () => await spendable(shadyWallet))
    let c = await faySwap.requestQuote(shady, 10 * USDC)
    c = await faySwap.lockAndRequest(shady, c)
    say(`  1. Fay locks ${formatUsdc(c.quote.usdc)} for a different liquidity agent, which quoted ${sats(c.quote.sats)} but locks only ${sats(c.lock!.satoshis)}`)
    await pace()
    c = await faySwap.claim(c)
    say(`  2. Fay's agent: ${c.steps.at(-1)}`)
    await pace()
    clock = (await usdc.htlc(c.sourceHtlcId!))!.refundAfter
    c = await faySwap.refundSource(c)
    say(`  3. After the timeout: ${c.steps.at(-1)}. The secret never left Fay, so nobody can take the USDC.`)
    say(await balances())

    return {
      happy: {
        usdcPaid: r.quote.usdc,
        satsReceived: r.lock!.satoshis,
        lpUsdc: htlc!.amount,
        pledged: pledge.amount,
        campaignTitle: meta.title,
        secretRevealedOnBsv: htlc!.secret === r.secret
      },
      cheat: { refused: c.steps.some(s => /not claiming/.test(s)), reason: c.steps.find(s => /not claiming/.test(s)) ?? '', usdcBack: await usdc.account('0xFay').balance() }
    }
  } finally {
    await new Promise(resolve => server.close(resolve))
    await chain.close()
  }
}
