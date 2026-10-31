/**
 * The bridge with the liquidity agent as its own service: a donor talks to it
 * over HTTP only, the USDC side is the Solidity HTLC on Anvil, the BSV side
 * the mock chain. Then the agent "crashes" after locking sats and a fresh
 * process, reading the same state file, still collects the USDC (S4).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import type { Server } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { Transaction } from '@bsv/sdk'
import type { Wallet } from '@bsv/wallet-toolbox'
import { anvil as anvilChain } from 'viem/chains'
import { fileStore } from '../agent/ledger'
import { anvilAccount, anvilBinary, startAnvil, type Anvil } from '../swap/anvil'
import type { SpendFinder } from '../swap/bsv'
import { DonorSwap } from '../swap/donorSwap'
import { deployBridgeContracts, EvmUsdcChain, mintTestUsdc } from '../swap/evmChain'
import { DEFAULT_LIQUIDITY, LiquidityAgent, type LpSwap } from '../swap/liquidityAgent'
import { LiquidityClient } from '../swap/lpClient'
import { createLiquidityApp } from '../swap/lpHttp'
import { createBrc29Payment } from '../client/payments'
import { USDC } from '../swap/usdcChain'
import { createMockChain, type MockChain } from './helpers/mockchain'

const deployer = anvilAccount(0); const donorEvm = anvilAccount(1); const lpEvm = anvilAccount(2)
let node: Anvil, evm: EvmUsdcChain, chain: MockChain, lpWallet: Wallet, stateFile: string
let server: Server, client: LiquidityClient

const spendable = async (w: Wallet): Promise<number> => (await w.listOutputs({ basket: 'default', limit: 1000 })).outputs.filter(o => o.spendable).reduce((s, o) => s + o.satoshis, 0)
const findSpend: SpendFinder = async (txid, vout) => {
  const storage = (chain.services as any).storage
  const row = await storage.knex('mockchain_utxos').where({ txid, vout }).first()
  return row?.spentByTxid == null ? undefined : Transaction.fromBinary(Array.from((await storage.getTransaction(row.spentByTxid)).rawTx as number[]))
}
/** A liquidity agent process: same wallet, same EVM account, state in one file. */
const startLp = (): LiquidityAgent => new LiquidityAgent(lpWallet, evm, lpEvm.address, findSpend, async () => await spendable(lpWallet), DEFAULT_LIQUIDITY, fileStore<LpSwap[]>(stateFile, []))

describe.skipIf(anvilBinary() === undefined)('the liquidity agent as an independent service', () => {
  beforeAll(async () => {
    node = await startAnvil()
    const { htlc, token } = await deployBridgeContracts(node.rpcUrl, anvilChain, deployer, { withTestToken: true })
    evm = new EvmUsdcChain({ name: 'USDC (local EVM chain)', rpcUrl: node.rpcUrl, chain: anvilChain, htlc, token: token!, signers: [donorEvm, lpEvm] })
    await mintTestUsdc(node.rpcUrl, anvilChain, deployer, token!, donorEvm.address, 100 * USDC)
    chain = await createMockChain()
    lpWallet = await chain.makeWallet(); await chain.fund(lpWallet, 5_000_000)
    stateFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lp-')), 'lp-swaps.json')
    await new Promise<void>(resolve => { server = createLiquidityApp(startLp()).listen(0, '127.0.0.1', () => resolve()) })
    client = new LiquidityClient(`http://127.0.0.1:${(server.address() as any).port}`)
  }, 120_000)
  afterAll(async () => { await new Promise(r => server?.close(r)); await chain?.close(); await node?.stop() })

  it('publishes who it is, its chain, price and limits', async () => {
    expect(await client.info()).toMatchObject({ lpAddress: lpEvm.address, satsPerUsdc: 21_500, maxUsdc: 500, swaps: [] })
  })

  it('answers bad requests with a reason, not a crash', async () => {
    await expect(client.quote(0, '02' + 'ab'.repeat(32))).rejects.toThrow(/liquidity agent: amount must be positive/)
    await expect(client.acceptSourceLock('nope', 'ff'.repeat(32))).rejects.toThrow(/no open quote/)
  })

  it('anyone can top up its sats inventory with a BRC-29 payment (SPV-checked); a forged payment is refused', async () => {
    const identityKey = (await lpWallet.getPublicKey({ identityKey: true })).publicKey
    const sv: Server = await new Promise(resolve => { const x = createLiquidityApp(startLp(), { identityKey, chainTracker: chain.chainTracker }).listen(0, '127.0.0.1', () => resolve(x)) })
    try {
      const c = new LiquidityClient(`http://127.0.0.1:${(sv.address() as any).port}`)
      const info = await c.info() as { bsvIdentityKey: string, bsvSpendable: number }
      expect(info.bsvIdentityKey).toBe(identityKey)
      const funder = await chain.makeWallet(); await chain.fund(funder, 100_000)
      const r = await c.fund(await createBrc29Payment(funder, identityKey, 40_000, 'top-up'))
      expect(r.spendable).toBe(info.bsvSpendable + 40_000)
      const forged = { ...(await createBrc29Payment(funder, identityKey, 1_000, 'top-up')), senderIdentityKey: '02' + 'cd'.repeat(32) }
      await expect(c.fund(forged)).rejects.toThrow()
      await expect(client.fund(await createBrc29Payment(funder, identityKey, 1_000))).rejects.toThrow() // the default app serves no /fund
    } finally { await new Promise(resolve => sv.close(resolve)) }
  })

  it('happy path over HTTP, then a crash before collecting: a restarted agent still gets its USDC', async () => {
    const donorWallet = await chain.makeWallet()
    const swap = new DonorSwap(donorWallet, evm, donorEvm.address, chain.chainTracker)
    let r = await swap.requestQuote(client, 100 * USDC)
    r = await swap.lockAndRequest(client, r)
    expect(r.lock?.satoshis).toBe(2_150_000)
    expect(await swap.verifyLock(r)).toEqual([])
    r = await swap.claim(r)
    expect(r.state).toBe('claimed')
    expect(await spendable(donorWallet)).toBeGreaterThan(2_148_000)

    // The service dies before its next step. Its state file says it holds a locked swap.
    await new Promise(resolve => server.close(resolve))
    expect(JSON.parse(fs.readFileSync(stateFile, 'utf8')).map((s: LpSwap) => s.state)).toEqual(['locked'])

    const restarted = startLp()
    expect(restarted.state(r.quote.id)).toBe('locked')
    await restarted.step() // reads the secret from the donor's BSV claim, claims on the EVM contract
    expect(restarted.state(r.quote.id)).toBe('settled')
    expect(await evm.account(lpEvm.address).balance()).toBe(100 * USDC)
    expect(startLp().state(r.quote.id)).toBe('settled') // and that is persisted too
  }, 120_000)

  it('a donor whose reply was lost asks again and gets the lock that was made (no second lock)', async () => {
    server = await new Promise(resolve => { const s = createLiquidityApp(startLp()).listen(0, '127.0.0.1', () => resolve(s)) })
    client = new LiquidityClient(`http://127.0.0.1:${(server.address() as any).port}`)
    await mintTestUsdc(node.rpcUrl, anvilChain, deployer, (evm.opts.token), donorEvm.address, 10 * USDC)
    const swap = new DonorSwap(await chain.makeWallet(), evm, donorEvm.address, chain.chainTracker)
    let r = await swap.requestQuote(client, 10 * USDC)
    r = await swap.lockAndRequest(client, r)
    const made = r.lock!
    r.lock = undefined // the reply never arrived
    r = await swap.requestLock(client, r)
    expect(r.lock).toEqual(made)
    expect(await swap.verifyLock(r)).toEqual([])
    expect((await client.info() as any).swaps.filter((s: any) => s.state === 'locked')).toHaveLength(1)
  }, 120_000)
})

