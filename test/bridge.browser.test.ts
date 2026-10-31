/**
 * The donor signs in their OWN EVM wallet (EIP-1193), as in a browser. Anvil's
 * dev accounts are unlocked, so a request() shim forwarding to Anvil behaves
 * like window.ethereum: it answers eth_requestAccounts, signs typed data and
 * sends transactions itself. No EVM key exists in this process for the donor.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Transaction } from '@bsv/sdk'
import type { Wallet } from '@bsv/wallet-toolbox'
import { anvil as anvilChain } from 'viem/chains'
import { anvilAccount, anvilBinary, anvilMine, startAnvil, type Anvil } from '../swap/anvil'
import { connectBrowserEvm, type Eip1193 } from '../swap/browserEvm'
import type { SpendFinder } from '../swap/bsv'
import { DonorSwap } from '../swap/donorSwap'
import { deployBridgeContracts, EvmUsdcChain, mintTestUsdc } from '../swap/evmChain'
import { DEFAULT_LIQUIDITY, LiquidityAgent } from '../swap/liquidityAgent'
import { createLiquidityApp } from '../swap/lpHttp'
import { swapUsdcToSats } from '../swap/browserSwap'
import type { Server } from 'node:http'
import { USDC } from '../swap/usdcChain'
import { createMockChain, type MockChain } from './helpers/mockchain'

const deployer = anvilAccount(0); const lpEvm = anvilAccount(2)
const DONOR = '0x90F79bf6EB2c4f870365E785982E1f101E93b906' // Anvil dev account 3: unlocked in the node, no key here
let node: Anvil, chain: MockChain, htlc: `0x${string}`, token: `0x${string}`
const calls: string[] = []
const spendable = async (w: Wallet): Promise<number> => (await w.listOutputs({ basket: 'default', limit: 1000 })).outputs.filter(o => o.spendable).reduce((s, o) => s + o.satoshis, 0)
const findSpend: SpendFinder = async (txid, vout) => {
  const storage = (chain.services as any).storage
  const row = await storage.knex('mockchain_utxos').where({ txid, vout }).first()
  return row?.spentByTxid == null ? undefined : Transaction.fromBinary(Array.from((await storage.getTransaction(row.spentByTxid)).rawTx as number[]))
}
/** A stand-in for window.ethereum: the wallet (here Anvil) holds the donor's key and signs. */
const provider = (): Eip1193 => ({
  request: (async ({ method, params }: { method: string, params?: unknown }) => {
    calls.push(method)
    if (method === 'eth_requestAccounts') return [DONOR]
    const r = await fetch(node.rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: params ?? [] }) })
    const j = await r.json() as { result?: unknown, error?: { message: string } }
    if (j.error !== undefined) throw new Error(j.error.message)
    return j.result
  }) as Eip1193['request']
})

describe.skipIf(anvilBinary() === undefined)('the donor signs in their own EVM wallet (EIP-1193)', () => {
  beforeAll(async () => {
    node = await startAnvil()
    ;({ htlc, token } = await deployBridgeContracts(node.rpcUrl, anvilChain, deployer, { withTestToken: true }) as { htlc: `0x${string}`, token: `0x${string}` })
    await mintTestUsdc(node.rpcUrl, anvilChain, deployer, token, DONOR, 50 * USDC)
    chain = await createMockChain()
  }, 120_000)
  afterAll(async () => { await chain?.close(); await node?.stop() })

  it('connects, locks USDC with a permit signed by the wallet, and the swap completes into the donor\'s BSV wallet', async () => {
    const { chain: donorEvm, address } = await connectBrowserEvm(provider(), { name: 'USDC (browser wallet)', rpcUrl: node.rpcUrl, chain: anvilChain, htlc, token, permit: true })
    expect(address).toBe(DONOR)
    const lpSide = new EvmUsdcChain({ name: 'USDC (LP)', rpcUrl: node.rpcUrl, chain: anvilChain, htlc, token, signers: [lpEvm] })
    const lpWallet = await chain.makeWallet(); await chain.fund(lpWallet, 3_000_000)
    const lp = new LiquidityAgent(lpWallet, lpSide, lpEvm.address, findSpend, async () => await spendable(lpWallet))
    const bsvWallet = await chain.makeWallet()
    const swap = new DonorSwap(bsvWallet, donorEvm, address, chain.chainTracker)
    let r = await swap.requestQuote(lp, 20 * USDC)
    r = await swap.lockAndRequest(lp, r)
    expect(calls).toContain('eth_signTypedData_v4') // the permit was signed by the wallet
    expect(calls).toContain('eth_sendTransaction') // and the wallet sent the lock
    r = await swap.claim(r)
    expect(r.state).toBe('claimed')
    await lp.step()
    expect(lp.state(r.quote.id)).toBe('settled')
    expect(await lpSide.account(lpEvm.address).balance()).toBe(20 * USDC)
    expect(await spendable(bsvWallet)).toBeGreaterThan(20 * 21_500 - 2_000)
  }, 120_000)

  it('stops if the wallet is on another chain and refuses to switch', async () => {
    const wrongChain: Eip1193 = { request: (async ({ method }: { method: string }) => {
      if (method === 'eth_requestAccounts') return [DONOR]
      if (method === 'eth_chainId') return '0x1'
      throw new Error('User rejected the request.')
    }) as Eip1193['request'] }
    await expect(connectBrowserEvm(wrongChain, { name: 'x', rpcUrl: node.rpcUrl, chain: anvilChain, htlc, token })).rejects.toThrow(/rejected/)
  })

  it('the web app\'s one-call flow: EVM wallet + liquidity agent over HTTP + BSV wallet, with a wait for confirmations', async () => {
    const lpSide = new EvmUsdcChain({ name: 'USDC (LP)', rpcUrl: node.rpcUrl, chain: anvilChain, htlc, token, signers: [lpEvm] })
    const lpWallet = await chain.makeWallet(); await chain.fund(lpWallet, 3_000_000)
    const lp = new LiquidityAgent(lpWallet, lpSide, lpEvm.address, findSpend, async () => await spendable(lpWallet), { ...DEFAULT_LIQUIDITY, minSourceConfirmations: 2 })
    const server: Server = await new Promise(resolve => { const s = createLiquidityApp(lp).listen(0, '127.0.0.1', () => resolve(s)) })
    // Mine only once the flow says it is waiting: right after the lock there is 1 confirmation, so it always waits first.
    let mining: ReturnType<typeof setInterval> | undefined
    try {
      const bsvWallet = await chain.makeWallet()
      const lines: string[] = []
      const r = await swapUsdcToSats(provider(), bsvWallet, chain.chainTracker, { lpUrl: `http://127.0.0.1:${(server.address() as any).port}`, evm: { name: 'USDC', rpcUrl: node.rpcUrl, chain: anvilChain, htlc, token, permit: true }, retryMs: 100 }, 10 * USDC, l => {
        lines.push(l)
        if (/waiting for confirmations/.test(l) && mining === undefined) mining = setInterval(() => { void anvilMine(node.rpcUrl, 1) }, 50)
      })
      expect(r.state).toBe('claimed')
      expect(lines.join('\n')).toMatch(/waiting for confirmations/)
      expect(await spendable(bsvWallet)).toBeGreaterThan(10 * 21_500 - 2_000)
    } finally { clearInterval(mining); await new Promise(r => server.close(r)) }
  }, 120_000)
})

