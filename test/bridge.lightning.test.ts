/**
 * The Lightning leg of the bridge on real LND nodes (regtest bitcoind + two LND 0.21 nodes, one
 * channel donor → agent): the donor pays a hold invoice under their own hashlock, the unchanged
 * LiquidityAgent locks BSV sats once the payment is held, and settles it with the secret the donor
 * reveals on BSV. Skipped when bitcoind or lnd is not installed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import { Transaction } from '@bsv/sdk'
import type { Wallet } from '@bsv/wallet-toolbox'
import { bitcoindBinary, startRegtest, type Regtest } from '../swap/bitcoind'
import type { SpendFinder } from '../swap/bsv'
import { checkSwapInvoice, decodeInvoice } from '../swap/bolt11'
import { swapLightningToSats } from '../swap/browserLightning'
import { DonorSwap } from '../swap/donorSwap'
import { LiquidityClient } from '../swap/lpClient'
import { createLiquidityApp } from '../swap/lpHttp'
import { LightningChain } from '../swap/lightningChain'
import { DEFAULT_LIQUIDITY, LiquidityAgent } from '../swap/liquidityAgent'
import { lndBinary, openChannel, startLnd, waitFor, type LndNode } from '../swap/lnd'
import { createMockChain, type MockChain } from './helpers/mockchain'

let btc: Regtest, donor: LndNode, agentNode: LndNode, chain: MockChain, lpWallet: Wallet
let donorLn: LightningChain, agentLn: LightningChain
// Both sides' Lightning clocks run 30 days in the past, so the BSV timelocks derived from them are already
// final on the mock chain (as in bridge.evm.failures); `skew` moves the agent's clock past T2.
let skew = 0
const past = (): number => Math.floor(Date.now() / 1000) - 30 * 86_400
const spendable = async (w: Wallet): Promise<number> => (await w.listOutputs({ basket: 'default', limit: 1000 })).outputs.filter(o => o.spendable).reduce((s, o) => s + o.satoshis, 0)
const findSpend: SpendFinder = async (txid, vout) => {
  const storage = (chain.services as any).storage
  const row = await storage.knex('mockchain_utxos').where({ txid, vout }).first()
  return row?.spentByTxid == null ? undefined : Transaction.fromBinary(Array.from((await storage.getTransaction(row.spentByTxid)).rawTx as number[]))
}

describe.skipIf(bitcoindBinary() === undefined || lndBinary() === undefined)('bridge over Lightning (LND hold invoices, regtest)', () => {
  beforeAll(async () => {
    btc = await startRegtest({ zmq: true })
    ;[donor, agentNode] = await Promise.all([startLnd(btc, 'donor'), startLnd(btc, 'agent')])
    await openChannel(btc, donor, agentNode, 500_000)
    donorLn = new LightningChain({ nodes: [donor.rest], clock: past }) // the donor's process sees only the donor's node
    agentLn = new LightningChain({ nodes: [agentNode.rest], clock: () => past() + skew }) // and the agent's only the agent's
    chain = await createMockChain()
    lpWallet = await chain.makeWallet(); await chain.fund(lpWallet, 50_000_000)
  }, 240_000)
  afterAll(async () => { await chain?.close(); await donor?.stop(); await agentNode?.stop(); await btc?.stop() })

  const agent = (): LiquidityAgent => new LiquidityAgent(lpWallet, agentLn, agentNode.pubkey, findSpend, async () => await spendable(lpWallet), { ...DEFAULT_LIQUIDITY, satsPerUsdc: 200_000_000_000, maxUsdc: 1_000_000 })

  it('happy path: 10,000 sats over Lightning become 20,000,000 BSV sats in the donor\'s wallet; the agent settles with the revealed secret', async () => {
    const lp = agent()
    const wallet = await chain.makeWallet()
    const swap = new DonorSwap(wallet, donorLn, donor.pubkey, chain.chainTracker)
    const agentBefore = await agentLn.account(agentNode.pubkey).balance()

    let r = await swap.requestQuote(lp, 10_000)
    expect(r.quote.sats).toBe(20_000_000)
    r = await swap.lockAndRequest(lp, r) // the agent issues a hold invoice; the donor checks and pays it
    expect(r.sourceHtlcId).toBe(r.hashlock)
    await waitFor(async () => (await agentLn.htlc(r.hashlock))?.amount === 10_000, 'the held payment')
    if (r.lock === undefined) r = await swap.requestLock(lp, r) // the first ask may come before the HTLC arrived ("wait:")
    expect(await agentLn.htlc(r.hashlock)).toMatchObject({ state: 'locked', amount: 10_000, receiver: agentNode.pubkey })
    expect(await donorLn.htlc(r.hashlock)).toMatchObject({ state: 'locked', amount: 10_000, sender: donor.pubkey, receiver: agentNode.pubkey })
    expect(await swap.verifyLock(r)).toEqual([])

    r = await swap.claim(r)
    expect(r.state).toBe('claimed')
    expect(await spendable(wallet)).toBeGreaterThan(20_000_000 - 2_000)

    await lp.step() // reads the secret from the BSV claim and settles the invoice
    expect(lp.state(r.quote.id)).toBe('settled')
    await waitFor(async () => (await donorLn.htlc(r.hashlock))?.state === 'claimed', 'the payment to succeed')
    expect((await donorLn.htlc(r.hashlock))!.secret).toBe(r.secret)
    // The payer sees SUCCEEDED a moment before the payee's channel balance is updated.
    await waitFor(async () => await agentLn.account(agentNode.pubkey).balance() === agentBefore + 10_000, 'the agent\'s channel balance')
  }, 120_000)

  it('the donor refuses an invoice that is not what was agreed; a cancelled invoice pays the donor back at once', async () => {
    const lp = agent()
    const swap = new DonorSwap(await chain.makeWallet(), donorLn, donor.pubkey, chain.chainTracker)
    let r = await swap.requestQuote(lp, 5_000)
    const refundAfter = past() + 5 * 3600
    const tooMuch = await agentLn.request(agentNode.pubkey, { amount: 6_000, hashlock: r.hashlock, refundAfter })
    await expect(donorLn.account(donor.pubkey).lock({ receiver: agentNode.pubkey, amount: 5_000, hashlock: r.hashlock, refundAfter, request: tooMuch })).rejects.toThrow(/asks 6000 sats/)
    await agentLn.cancel(agentNode.pubkey, r.hashlock)

    r = await swap.requestQuote(lp, 5_000)
    r = await swap.lockAndRequest(lp, r)
    await expect(swap.refundSource(r)).rejects.toThrow(/comes back when the agent cancels/)
    await agentLn.cancel(agentNode.pubkey, r.hashlock) // e.g. the agent won't lock sats after all
    await waitFor(async () => (await donorLn.htlc(r.hashlock))?.state === 'refunded', 'the payment to fail back')
    r = await swap.refundSource(r)
    expect(r.state).toBe('refunded')
  }, 120_000)

  it('the donor never claims: after T2 the agent refunds its sats AND cancels the invoice, so the donor is paid back at once', async () => {
    const lp = agent()
    const swap = new DonorSwap(await chain.makeWallet(), donorLn, donor.pubkey, chain.chainTracker)
    let r = await swap.requestQuote(lp, 5_000)
    r = await swap.lockAndRequest(lp, r)
    await waitFor(async () => (await agentLn.htlc(r.hashlock))?.amount === 5_000, 'the held payment')
    if (r.lock === undefined) r = await swap.requestLock(lp, r)
    expect(r.lock).toBeDefined()
    skew = r.lock!.terms.refundAfter - past() + 60 // the agent's clock passes T2
    try { await lp.step() } finally { skew = 0 }
    expect(lp.state(r.quote.id)).toBe('refunded')
    expect(lp.log.some(l => /released the donor's BTC lock/.test(l))).toBe(true)
    await waitFor(async () => (await donorLn.htlc(r.hashlock))?.state === 'refunded', 'the payment to fail back')
  }, 120_000)

  it('the same swap through the agent\'s HTTP service (POST /api/lp/request issues the invoice)', async () => {
    const lp = agent()
    const server: Server = await new Promise(resolve => { const sv = createLiquidityApp(lp).listen(0, '127.0.0.1', () => resolve(sv)) })
    try {
      const client = new LiquidityClient(`http://127.0.0.1:${(server.address() as any).port}`)
      expect(await client.info()).toMatchObject({ asset: { symbol: 'BTC', decimals: 8 }, lpAddress: agentNode.pubkey })
      const wallet = await chain.makeWallet()
      const swap = new DonorSwap(wallet, donorLn, donor.pubkey, chain.chainTracker)
      let r = await swap.requestQuote(client, 5_000)
      r = await swap.lockAndRequest(client, r)
      await waitFor(async () => (await agentLn.htlc(r.hashlock))?.amount === 5_000, 'the held payment')
      if (r.lock === undefined) r = await swap.requestLock(client, r)
      r = await swap.claim(r)
      expect(r.state).toBe('claimed')
      await lp.step()
      await waitFor(async () => (await donorLn.htlc(r.hashlock))?.state === 'claimed', 'the payment to settle')
    } finally { await new Promise(resolve => server.close(resolve)) }
  }, 120_000)

  it('our BOLT 11 decoder reads LND\'s invoices exactly as LND does (what a donor with any wallet checks)', async () => {
    const hashlock = 'ab'.repeat(32)
    const refundAfter = past() + 5 * 3600
    const invoice = await agentLn.request(agentNode.pubkey, { amount: 7_000, hashlock, refundAfter })
    const lnd = await donor.rest.call<any>('GET', `/v1/payreq/${invoice}`)
    const ours = decodeInvoice(invoice)
    expect(ours).toMatchObject({ network: 'regtest', amountSat: Number(lnd.num_satoshis), paymentHash: lnd.payment_hash, payee: lnd.destination, minFinalCltv: Number(lnd.cltv_expiry), timestamp: Number(lnd.timestamp) })
    expect(ours.payee).toBe(agentNode.pubkey)
    expect(checkSwapInvoice(invoice, { paymentHash: hashlock, amountSat: 7_000, payee: agentNode.pubkey, minFinalCltv: 30, network: 'regtest' })).toEqual([])
    expect(checkSwapInvoice(invoice, { paymentHash: hashlock, amountSat: 7_000, payee: donor.pubkey, minFinalCltv: 30 })).toEqual(['the invoice pays a different node than the liquidity agent'])
    await agentLn.cancel(agentNode.pubkey, hashlock)
  }, 60_000)

  it('a donor with no Lightning node: any wallet pays (here the donor\'s LND, fire-and-forget like WebLN), through the agent\'s HTTP service', async () => {
    const lp = agent()
    const server: Server = await new Promise(resolve => { const sv = createLiquidityApp(lp).listen(0, '127.0.0.1', () => resolve(sv)) })
    try {
      const wallet = await chain.makeWallet()
      const payer = async (invoice: string): Promise<void> => { donor.rest.stream('/v2/router/send', { payment_request: invoice, timeout_seconds: 60, fee_limit_sat: '100' }, () => {}) }
      const steps: string[] = []
      const r = await swapLightningToSats(wallet, chain.chainTracker, { lpUrl: `http://127.0.0.1:${(server.address() as any).port}`, retryMs: 300, clock: past }, 5_000, payer, l => steps.push(l))
      expect(r.state).toBe('claimed')
      expect(steps.join('\n')).toMatch(/invoice checked/)
      expect(await spendable(wallet)).toBeGreaterThan(10_000_000 - 2_000)
      await lp.step()
      expect(lp.state(r.quote.id)).toBe('settled')
      await waitFor(async () => (await agentLn.htlc(r.hashlock))?.state === 'claimed', 'the invoice to settle')
    } finally { await new Promise(resolve => server.close(resolve)) }
  }, 120_000)
})
