/**
 * The Bitcoin (BTC) leg of the bridge on a real Bitcoin Core node (regtest): the BTC HTLC is a
 * P2WSH script that bitcoind itself validates, and the unchanged LiquidityAgent and DonorSwap
 * swap BTC for BSV sats. Skipped when no bitcoind is installed (see swap/bitcoind.ts).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Hash, PrivateKey, Transaction, Utils } from '@bsv/sdk'
import type { Wallet } from '@bsv/wallet-toolbox'
import { bitcoindBinary, startRegtest, type Regtest } from '../swap/bitcoind'
import { btcPublicKey, claimTx, decodeSegwitAddress, htlcScript, p2wpkh, parseHtlcScript, refundTx, segwitAddress, serializeTx, type BtcTx } from '../swap/btc'
import { BitcoindBackend, bitcoindWalletFunder, BtcChain } from '../swap/btcChain'
import type { SpendFinder } from '../swap/bsv'
import { DonorSwap } from '../swap/donorSwap'
import { refundBtc, swapBtcToSats, type BtcRefundTicket } from '../swap/browserBtc'
import { createLiquidityApp } from '../swap/lpHttp'
import type { Server } from 'node:http'
import { DEFAULT_LIQUIDITY, LiquidityAgent } from '../swap/liquidityAgent'
import { createMockChain, type MockChain } from './helpers/mockchain'

describe('BTC primitives', () => {
  it('bech32 matches the BIP 173 test vector', () => {
    expect(segwitAddress(p2wpkh('0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'), 'main')).toBe('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4')
  })
  it('the HTLC script round-trips, and anything else is refused', () => {
    const t = { hashlock: 'ab'.repeat(32), receiver: btcPublicKey(PrivateKey.fromRandom()), sender: btcPublicKey(PrivateKey.fromRandom()), refundAfter: 1_800_000_000 }
    const s = htlcScript(t)
    expect(parseHtlcScript(s)).toEqual(t)
    expect(parseHtlcScript([...s, 0x75])).toBeUndefined()
    expect(parseHtlcScript(s.map((b, i) => i === 3 ? 33 : b))).toBeUndefined() // a secret size other than 32
    expect(() => htlcScript({ ...t, refundAfter: 100 })).toThrow(/unix time/)
  })
})

const BTC_SATS_PER_BSV_SAT = 1 / 2_000 // ~2,000 BSV per BTC
const RATE = Math.round(1e8 / BTC_SATS_PER_BSV_SAT) // BSV sats per 1 BTC
let node: Regtest, btc: BtcChain, chain: MockChain, lpWallet: Wallet
const donorBtc = PrivateKey.fromRandom(); const lpBtc = PrivateKey.fromRandom()
const spendable = async (w: Wallet): Promise<number> => (await w.listOutputs({ basket: 'default', limit: 1000 })).outputs.filter(o => o.spendable).reduce((s, o) => s + o.satoshis, 0)
const findSpend: SpendFinder = async (txid, vout) => {
  const storage = (chain.services as any).storage
  const row = await storage.knex('mockchain_utxos').where({ txid, vout }).first()
  return row?.spentByTxid == null ? undefined : Transaction.fromBinary(Array.from((await storage.getTransaction(row.spentByTxid)).rawTx as number[]))
}

describe.skipIf(bitcoindBinary() === undefined)('bridge on a real Bitcoin node (regtest)', () => {
  beforeAll(async () => {
    node = await startRegtest()
    btc = new BtcChain({ backend: new BitcoindBackend(node.rpc), network: 'regtest', signers: [donorBtc, lpBtc], funder: bitcoindWalletFunder(node.rpc, node.wallet) })
    chain = await createMockChain()
    lpWallet = await chain.makeWallet(); await chain.fund(lpWallet, 100_000_000)
  }, 120_000)
  afterAll(async () => { await chain?.close(); await node?.stop() })

  const agent = (): LiquidityAgent => new LiquidityAgent(lpWallet, btc, btcPublicKey(lpBtc), findSpend, async () => await spendable(lpWallet), { ...DEFAULT_LIQUIDITY, satsPerUsdc: RATE, maxUsdc: 1e8 })

  it('happy path: 0.0001 BTC become 20,000,000 sats in the donor\'s own BSV wallet; the agent collects the BTC', async () => {
    const lp = agent()
    const wallet = await chain.makeWallet()
    const swap = new DonorSwap(wallet, btc, btcPublicKey(donorBtc), chain.chainTracker)

    let r = await swap.requestQuote(lp, 10_000)
    expect(r.quote.sats).toBe(20_000_000)
    expect(r.steps[0]).toMatch(/0\.00010000 BTC/)
    r = await swap.lockAndRequest(lp, r)
    expect(r.lock).toBeUndefined() // still in the mempool: the agent waits for a confirmation
    expect(r.steps.at(-1)).toMatch(/wait: the BTC lock has 0 of 1 confirmations/)
    expect(await btc.htlc(r.sourceHtlcId!)).toMatchObject({ state: 'locked', amount: 10_000, hashlock: r.hashlock, receiver: btcPublicKey(lpBtc), confirmations: 0 })

    await node.mine(1)
    r = await swap.requestLock(lp, r)
    expect(await swap.verifyLock(r)).toEqual([])
    r = await swap.claim(r)
    expect(r.state).toBe('claimed')
    expect(await spendable(wallet)).toBeGreaterThan(20_000_000 - 2_000)

    await lp.step() // reads the secret from the donor's BSV claim, claims the BTC on Bitcoin
    expect(lp.state(r.quote.id)).toBe('settled')
    const h = await btc.htlc(r.sourceHtlcId!)
    expect(h).toMatchObject({ state: 'claimed', secret: r.secret })
    expect(Utils.toHex(Hash.sha256(Utils.toArray(h!.secret!, 'hex')))).toBe(r.hashlock)
    await node.mine(1)
    // Minus the claim's miner fee: regtest has no fee history, so the 2 sat/vB floor × ~140 vB.
    const fee = 10_000 - await btc.account(btcPublicKey(lpBtc)).balance()
    expect(fee).toBeGreaterThan(250); expect(fee).toBeLessThan(350)
  }, 120_000)

  it('a lock for the wrong amount is rejected, and the donor refunds the BTC only after the timeout (bitcoind enforces CLTV)', async () => {
    const lp = agent()
    const swap = new DonorSwap(await chain.makeWallet(), btc, btcPublicKey(donorBtc), chain.chainTracker)
    let r = await swap.requestQuote(lp, 10_000)
    r.quote = { ...r.quote, usdc: 9_000 } // the donor locks less than quoted
    r = await swap.lockAndRequest(lp, r)
    await node.mine(1)
    r = await swap.requestLock(lp, r)
    expect(r.lock).toBeUndefined()
    expect(r.steps.at(-1)).toMatch(/quote was 0\.00010000 BTC/)

    const t1 = (await btc.htlc(r.sourceHtlcId!))!.refundAfter
    await expect(swap.refundSource(r)).rejects.toThrow(/early/)
    // Our own checks aside, bitcoind itself refuses an early refund, a wrong secret and the wrong key:
    const [txid, vout, scriptHex] = r.sourceHtlcId!.split(':')
    const spend = { txid, vout: Number(vout), value: 9_000, witnessScript: Utils.toArray(scriptHex, 'hex'), to: p2wpkh(btcPublicKey(donorBtc)), fee: 1_000 }
    const send = async (tx: BtcTx): Promise<unknown> => await node.rpc.call('sendrawtransaction', [Utils.toHex(serializeTx(tx))])
    await expect(send(refundTx(spend, donorBtc, t1))).rejects.toThrow(/non-final/)
    await expect(send(claimTx(spend, lpBtc, '00'.repeat(32)))).rejects.toThrow(/script-verify|Script failed/i)
    await expect(send(claimTx(spend, donorBtc, r.secret))).rejects.toThrow(/script-verify|Script failed|Signature/i) // only the receiver's key
    await node.setMockTime(t1 + 3_600); await node.mine(11) // median time past moves beyond T1
    await swap.refundSource(r)
    await node.mine(1)
    expect((await btc.htlc(r.sourceHtlcId!))!.state).toBe('refunded')
    const fee = 9_000 - await btc.account(btcPublicKey(donorBtc)).balance()
    expect(fee).toBeGreaterThan(200); expect(fee).toBeLessThan(350)
  }, 120_000)

  it('decodes the node\'s own addresses (segwit v0 and taproot/bech32m) to the scripts it reports; refuses typos', async () => {
    for (const type of ['bech32', 'bech32m']) {
      const a = await node.rpc.call<string>('getnewaddress', ['', type], node.wallet)
      const info = await node.rpc.call<{ scriptPubKey: string }>('getaddressinfo', [a], node.wallet)
      expect(Utils.toHex(decodeSegwitAddress(a, 'regtest'))).toBe(info.scriptPubKey)
      expect(() => decodeSegwitAddress(a.slice(0, -1) + (a.endsWith('q') ? 'p' : 'q'), 'regtest')).toThrow(/checksum/)
      expect(() => decodeSegwitAddress(a, 'main')).toThrow(/not a main/)
    }
  })

  const withLp = async <T>(lp: LiquidityAgent, fn: (url: string) => Promise<T>): Promise<T> => {
    const sv: Server = await new Promise(resolve => { const x = createLiquidityApp(lp).listen(0, '127.0.0.1', () => resolve(x)) })
    try { return await fn(`http://127.0.0.1:${(sv.address() as any).port}`) } finally { await new Promise(resolve => sv.close(resolve)) }
  }
  const payFromNode = async (address: string, amount: number): Promise<void> => { await node.rpc.call('sendtoaddress', [address, amount / 1e8], node.wallet); await node.mine(1) }

  it('any wallet: the donor pays the HTLC address by hand (no txid given), the page finds it, and the swap completes over HTTP', async () => {
    const lp = agent()
    const wallet = await chain.makeWallet()
    const refundTo = await node.rpc.call<string>('getnewaddress', ['', 'bech32m'], node.wallet)
    const tickets: BtcRefundTicket[] = []
    const { record } = await withLp(lp, async url => await swapBtcToSats(wallet, chain.chainTracker, { lpUrl: url, network: 'regtest', backend: new BitcoindBackend(node.rpc), refundTo, retryMs: 200, fundingPollMs: 200 }, 10_000, payFromNode, t => tickets.push({ ...t })))
    expect(record.state).toBe('claimed')
    expect(tickets[0].htlcId).toBeUndefined() // the ticket exists BEFORE anything is paid
    expect(tickets.at(-1)!.htlcId).toBe(record.sourceHtlcId)
    expect(await spendable(wallet)).toBeGreaterThan(20_000_000 - 2_000)
    await lp.step()
    expect(lp.state(record.quote.id)).toBe('settled')
  }, 120_000)

  it('any wallet, swap fails: with only the saved ticket, the donor refunds the BTC to their own (taproot) address after the timeout', async () => {
    const lp = new LiquidityAgent(lpWallet, btc, btcPublicKey(lpBtc), findSpend, async () => await spendable(lpWallet), { ...DEFAULT_LIQUIDITY, satsPerUsdc: RATE, maxUsdc: 1e8, minSourceConfirmations: 50 })
    const refundTo = await node.rpc.call<string>('getnewaddress', ['', 'bech32m'], node.wallet)
    let ticket: BtcRefundTicket | undefined
    const { record } = await withLp(lp, async url => await swapBtcToSats(await chain.makeWallet(), chain.chainTracker, { lpUrl: url, network: 'regtest', backend: new BitcoindBackend(node.rpc), refundTo, retryMs: 50, maxRetries: 1, fundingPollMs: 200 }, 10_000, payFromNode, t => { ticket = JSON.parse(JSON.stringify(t)) }))
    expect(record.lock).toBeUndefined() // the agent kept waiting for 50 confirmations; the donor gave up
    await expect(refundBtc(ticket!, { backend: new BitcoindBackend(node.rpc) })).rejects.toThrow(/early/)
    await node.setMockTime(ticket!.refundAfter! + 3_600); await node.mine(11)
    await refundBtc(ticket!, { backend: new BitcoindBackend(node.rpc) })
    await node.mine(1)
    const got = await node.rpc.call<number>('getreceivedbyaddress', [refundTo], node.wallet)
    expect(Math.round(got * 1e8)).toBeGreaterThan(10_000 - 400)
  }, 120_000)
})
