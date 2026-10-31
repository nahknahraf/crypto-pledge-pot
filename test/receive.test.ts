/**
 * "Fund from an exchange": an exchange (here: another wallet paying a plain
 * address, as an exchange withdrawal would) pays the user's deposit address;
 * the user's own wallet verifies and internalizes it, and can spend it at once.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Beef, P2PKH, Transaction } from '@bsv/sdk'
import type { Wallet } from '@bsv/wallet-toolbox'
import { atomicBeefOf, claimReceived, newReceiveAddress, paymentsTo } from '../client/receive'
import { createMockChain, type MockChain } from './helpers/mockchain'

let chain: MockChain, exchange: Wallet, user: Wallet
const spendable = async (w: Wallet): Promise<number> => (await w.listOutputs({ basket: 'default', limit: 1000 })).outputs.filter(o => o.spendable).reduce((s, o) => s + o.satoshis, 0)
const withdraw = async (address: string, sats: number): Promise<number[]> => {
  const res = await exchange.createAction({ description: 'Exchange withdrawal', outputs: [{ lockingScript: new P2PKH().lock(address).toHex(), satoshis: sats, outputDescription: 'withdrawal' }], options: { acceptDelayedBroadcast: false } })
  return Array.from(res.tx!)
}

beforeAll(async () => {
  chain = await createMockChain()
  exchange = await chain.makeWallet(); await chain.fund(exchange, 100_000)
  user = await chain.makeWallet()
}, 120_000)
afterAll(async () => { await chain?.close() })

describe('fund from an exchange', () => {
  it('a withdrawal to a fresh deposit address lands in the user\'s own wallet, verified, and is spendable at once', async () => {
    const to = await newReceiveAddress(user)
    expect(to.address).toMatch(/^1/)
    const { publicKey: identity } = await user.getPublicKey({ identityKey: true })
    expect(to.lockingScript).not.toContain(identity) // never P2PKH(identityKey)
    expect(await spendable(user)).toBe(0)
    const got = await claimReceived(user, to, await withdraw(to.address, 25_000), chain.chainTracker)
    expect(got).toBe(25_000)
    expect(await spendable(user)).toBe(25_000)
    const spend = await user.createAction({ description: 'Spend it', outputs: [{ lockingScript: new P2PKH().lock(to.address).toHex(), satoshis: 1_000, outputDescription: 'spend test' }] })
    expect(spend.txid).toMatch(/^[0-9a-f]{64}$/)
  })

  it('every address is fresh; a payment to another address claims nothing; a forged proof is refused', async () => {
    const a = await newReceiveAddress(user)
    const b = await newReceiveAddress(user)
    expect(a.address).not.toBe(b.address)
    const toB = await withdraw(b.address, 3_000)
    expect(await claimReceived(user, a, toB, chain.chainTracker)).toBe(0)
    const lying = { isValidRootForHeight: async () => false, currentHeight: async () => 1 }
    await expect(claimReceived(user, b, toB, lying)).rejects.toThrow(/SPV/)
  })

  it('reads unspent payments to an address from WhatsOnChain (mocked HTTP)', async () => {
    const fake = (async () => new Response(JSON.stringify([{ tx_hash: 'aa' }, { tx_hash: 'bb' }, { tx_hash: 'aa' }]))) as unknown as typeof fetch
    expect(await paymentsTo('1abc', 'main', fake)).toEqual(['aa', 'bb'])
  })

  it('accepts plain BEEF as WhatsOnChain serves it, as well as AtomicBEEF', async () => {
    const to = await newReceiveAddress(user)
    const atomic = await withdraw(to.address, 4_000)
    const txid = Transaction.fromAtomicBEEF(atomic).id('hex')
    const plain = Beef.fromBinary(atomic).toBinary()
    expect(() => Transaction.fromAtomicBEEF(plain)).toThrow()
    expect(atomicBeefOf(atomic, txid)).toBe(atomic)
    expect(await claimReceived(user, to, atomicBeefOf(plain, txid), chain.chainTracker)).toBe(4_000)
  })
})

