/**
 * Zero-click funding (shared/treasury.ts) on the mock chain: one deposit is claimed (SPV) once, then the
 * treasury tops up the real fundraising-agent and liquidity-agent HTTP apps by itself; a recipient that is
 * down is reported without stopping the others.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import { P2PKH, Transaction } from '@bsv/sdk'
import type { Wallet } from '@bsv/wallet-toolbox'
import { newReceiveAddress } from '../client/receive'
import { createAgentApp } from '../fundraising-agent/http'
import { Ledger, memoryStore, type AgentState, type SpendEntry } from '../fundraising-agent/ledger'
import { createLiquidityApp } from '../liquidity-agent/lpHttp'
import { LiquidityAgent } from '../liquidity-agent/liquidityAgent'
import { SimulatedUsdcChain } from '../liquidity-agent/usdcChain'
import { claimDeposits, fundAgents, identityFromStatus } from '../shared/treasury'
import { createMockChain, type MockChain } from './helpers/mockchain'

let chain: MockChain, treasury: Wallet, agentWallet: Wallet, lpWallet: Wallet
const servers: Server[] = []
const spendable = async (w: Wallet): Promise<number> => (await w.listOutputs({ basket: 'default', limit: 1000 })).outputs.filter(o => o.spendable).reduce((s, o) => s + o.satoshis, 0)
const listen = async (app: any): Promise<string> => await new Promise(resolve => { const s: Server = app.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(s.address() as any).port}`)); servers.push(s) })

beforeAll(async () => {
  chain = await createMockChain()
  treasury = await chain.makeWallet()
  agentWallet = await chain.makeWallet(); lpWallet = await chain.makeWallet()
}, 60_000)
afterAll(async () => { for (const s of servers) await new Promise(r => s.close(r)); await chain?.close() })

describe('zero-click funding', () => {
  it('reads the identity key from every agent\'s status shape', () => {
    const k = '02' + 'ab'.repeat(32)
    expect(identityFromStatus({ identityKey: k })).toBe(k) // fundraising agent
    expect(identityFromStatus({ wallet: { identityKey: k } })).toBe(k) // autopilot donor agent
    expect(identityFromStatus({ bsvIdentityKey: k })).toBe(k) // liquidity agent
    expect(identityFromStatus({ wallet: null })).toBeUndefined() // co-pilot donor agent: no wallet to fund
  })

  it('one deposit from anywhere is claimed once (SPV), and a restart does not claim it twice', async () => {
    const address = await newReceiveAddress(treasury, 'main')
    const payer = await chain.makeWallet(); await chain.fund(payer, 50_000)
    const res = await payer.createAction({ description: 'Team deposit', outputs: [{ lockingScript: new P2PKH().lock(address.address).toHex(), satoshis: 30_000, outputDescription: 'deposit' }], options: { acceptDelayedBroadcast: false } })
    const txid = Transaction.fromAtomicBEEF(Array.from(res.tx!)).id('hex')
    const deps = { network: 'main' as const, chainTracker: chain.chainTracker, fetchBeef: async () => Array.from(res.tx!), listPayments: async () => [txid] }
    expect(await claimDeposits(treasury, address, [], deps)).toEqual([{ txid, sats: 30_000 }])
    expect(await claimDeposits(treasury, address, [txid], deps)).toEqual([]) // already claimed
    expect(await spendable(treasury)).toBe(30_000)
  })

  it('tops up each agent through its own fund endpoint; one that is down does not stop the others', async () => {
    const agentUrl = await listen(createAgentApp({ wallet: agentWallet, ledger: new Ledger(memoryStore<SpendEntry[]>([])), state: memoryStore<AgentState>({ worked: [] }), chainTracker: chain.chainTracker, mission: 'm', spendable: async () => await spendable(agentWallet), lastOutcome: () => undefined }))
    const lp = new LiquidityAgent(lpWallet, new SimulatedUsdcChain(), '0xLP', async () => undefined, async () => await spendable(lpWallet))
    const lpUrl = await listen(createLiquidityApp(lp, { identityKey: (await lpWallet.getPublicKey({ identityKey: true })).publicKey, chainTracker: chain.chainTracker }))
    const results = await fundAgents(treasury, [
      { name: 'fundraising agent', statusUrl: `${agentUrl}/api/agent`, fundUrl: `${agentUrl}/api/agent/fund`, sats: 4_000 },
      { name: 'donor agent (down)', statusUrl: 'http://127.0.0.1:1/api/donor', fundUrl: 'http://127.0.0.1:1/api/donor/fund', sats: 1_500 },
      { name: 'liquidity agent', statusUrl: `${lpUrl}/api/lp`, fundUrl: `${lpUrl}/api/lp/fund`, sats: 5_000 }
    ])
    expect(results.map(r => [r.name, r.ok])).toEqual([['fundraising agent', true], ['donor agent (down)', false], ['liquidity agent', true]])
    expect(await spendable(agentWallet)).toBe(4_000)
    expect(await spendable(lpWallet)).toBe(5_000)
  })
})
