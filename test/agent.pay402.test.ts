/**
 * Step 1 of the agent: the paid data API and the agent's capped 402 payer.
 * Real wallet-toolbox wallets on the mock chain; every payment is a real
 * BRC-29 transfer that the provider internalizes.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import type { Wallet } from '@bsv/wallet-toolbox'
import { createDataProviderApp, syntheticReading } from '../agent/dataProvider'
import { createCappedPayer, PaymentRefused } from '../agent/pay402'
import { createMockChain, type MockChain } from './helpers/mockchain'

let chain: MockChain
let agent: Wallet, provider: Wallet, greedy: Wallet
let cheap: Server, pricey: Server
let cheapUrl: string, priceyUrl: string

const spendable = async (w: Wallet): Promise<number> =>
  (await w.listOutputs({ basket: 'default', limit: 1000 })).outputs.filter(o => o.spendable).reduce((s, o) => s + o.satoshis, 0)
const listen = async (app: any): Promise<[Server, string]> => await new Promise(resolve => {
  const s = app.listen(0, () => resolve([s, `127.0.0.1:${(s.address() as any).port}`]))
})

beforeAll(async () => {
  chain = await createMockChain()
  agent = await chain.makeWallet()
  provider = await chain.makeWallet()
  greedy = await chain.makeWallet()
  await chain.fund(agent, 100_000)
  ;[cheap, cheapUrl] = await listen(createDataProviderApp(provider, 50))
  ;[pricey, priceyUrl] = await listen(createDataProviderApp(greedy, 5_000))
})
afterAll(async () => {
  await new Promise(r => cheap?.close(r)); await new Promise(r => pricey?.close(r))
  await chain?.close()
})

describe('capped 402 payer', () => {
  it('pays the allow-listed provider its price and gets the data', async () => {
    const pay = createCappedPayer({ wallet: agent, allowedHosts: [cheapUrl], maxPricePerCall: 100 })
    const before = await spendable(provider)
    const r = await pay<any>(`http://${cheapUrl}/data/munich`)
    expect(r.paid).toBe(50)
    expect(r.txid).toMatch(/^[0-9a-f]{64}$/)
    expect(r.body).toMatchObject({ ...syntheticReading('munich'), synthetic: true })
    expect(await spendable(provider)).toBe(before + 50)
  })

  it('refuses a price above its cap without paying', async () => {
    const pay = createCappedPayer({ wallet: agent, allowedHosts: [cheapUrl, priceyUrl], maxPricePerCall: 100 })
    const before = await spendable(agent)
    await expect(pay(`http://${priceyUrl}/data/munich`)).rejects.toThrow(PaymentRefused)
    await expect(pay(`http://${priceyUrl}/data/munich`)).rejects.toThrow(/asks 5000 sats/)
    expect(await spendable(agent)).toBe(before)
  })

  it('refuses hosts that are not allow-listed', async () => {
    const pay = createCappedPayer({ wallet: agent, allowedHosts: [cheapUrl], maxPricePerCall: 10_000 })
    await expect(pay(`http://${priceyUrl}/data/munich`)).rejects.toThrow(/allow-list/)
  })
})
