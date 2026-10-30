/** The web app's wallet gate (§7): when may the app touch the user's wallet at all? */
import { describe, expect, it } from 'vitest'
import { openWallet, spendPrompt, type GateWallet } from '../app/src/walletGate'

const fakeWallet = (network: string, opts: { locked?: boolean } = {}) => {
  const calls: string[] = []
  const w: GateWallet = {
    waitForAuthentication: async () => { calls.push('auth'); if (opts.locked === true) throw new Error('no wallet listening'); return { authenticated: true } },
    getNetwork: async () => { calls.push('network'); return { network: network as 'mainnet' } },
    getPublicKey: async () => { calls.push('key'); return { publicKey: '02' + 'ab'.repeat(32) } }
  }
  return { w, calls }
}

describe('the wallet gate', () => {
  it('offline demo (mock): the wallet is never even constructed', async () => {
    let made = 0
    const r = await openWallet(async () => ({ network: 'mock' }), () => { made++; return fakeWallet('mainnet').w })
    expect(r).toMatchObject({ ok: false, server: 'mock', error: /offline demo/ })
    expect(made).toBe(0)
  })
  it('server unreachable: no wallet', async () => {
    let made = 0
    const r = await openWallet(async () => { throw new Error('down') }, () => { made++; return fakeWallet('mainnet').w })
    expect(r).toMatchObject({ ok: false, error: /unreachable/ })
    expect(made).toBe(0)
  })
  it('a testnet wallet against a mainnet server is refused before any key is read', async () => {
    const { w, calls } = fakeWallet('testnet')
    const r = await openWallet(async () => ({ network: 'main' }), () => w)
    expect(r).toMatchObject({ ok: false, error: /wallet is on testnet but this CryptoPledgePot server runs on mainnet/ })
    expect(calls).not.toContain('key')
  })
  it('no wallet running: a clear message', async () => {
    const r = await openWallet(async () => ({ network: 'main' }), () => fakeWallet('mainnet', { locked: true }).w)
    expect(r).toMatchObject({ ok: false, error: /Open and unlock BSV Desktop/ })
  })
  it('matching networks: connected, with the identity key; a known server network skips the health call', async () => {
    let healthCalls = 0
    const r = await openWallet(async () => { healthCalls++; return { network: 'main' } }, () => fakeWallet('mainnet').w, 'main')
    expect(r).toMatchObject({ ok: true, server: 'main', network: 'mainnet', identityKey: /^02/ })
    expect(healthCalls).toBe(0)
  })
  it('the spend prompt names the action and says it is a real transaction', () => {
    expect(spendPrompt('Donate 3,000 sats to "Well"?')).toMatch(/^Donate 3,000 sats to "Well"\?\n\nThis is a real BSV transaction from your wallet\. Continue\?$/)
  })
})
