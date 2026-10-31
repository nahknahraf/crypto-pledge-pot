/**
 * EsploraBackend offline, with a stub fetch shaped like the real API (checked live, read-only,
 * against mempool.space mainnet and signet; see DEVLOG 9.4).
 */
import { describe, expect, it } from 'vitest'
import { Hash, Utils } from '@bsv/sdk'
import { EsploraBackend } from '../liquidity-agent/btcChain'

const TXID = 'aa'.repeat(32); const SPENDER = 'bb'.repeat(32)
const SCRIPT = '0020' + 'cc'.repeat(32)
const SCRIPTHASH = Utils.toHex(Hash.sha256(Utils.toArray(SCRIPT, 'hex')).reverse())
const routes: Record<string, unknown> = {
  [`/tx/${TXID}`]: { vout: [{ scriptpubkey: SCRIPT, value: 10_000 }], status: { confirmed: true, block_height: 98 } },
  '/blocks/tip/height': '100',
  '/blocks/tip/hash': 'ff'.repeat(32),
  [`/block/${'ff'.repeat(32)}`]: { mediantime: 1_800_000_000 },
  [`/tx/${TXID}/outspend/0`]: { spent: true, txid: SPENDER, vin: 1 },
  [`/tx/${SPENDER}`]: { vin: [{ witness: ['01'] }, { witness: ['30', 'dead', '01', 'beef'] }] },
  [`/scripthash/${SCRIPTHASH}/utxo`]: [{ value: 600 }, { value: 400 }],
  '/fee-estimates': { 1: 9, 2: 7, 6: 3.5, 144: 1 }
}
const stub = (async (url: string, init?: RequestInit) => {
  const path = url.replace('https://esplora.test/api', '')
  if (init?.method === 'POST') return new Response(path === '/tx' && init.body === '0200' ? 'ee'.repeat(32) : 'sendrawtransaction RPC error: bad-txns', { status: init.body === '0200' ? 200 : 400 })
  const body = routes[path]
  if (body === undefined) return new Response('Transaction not found', { status: 404 })
  return new Response(typeof body === 'string' ? body : JSON.stringify(body))
}) as typeof fetch
const b = new EsploraBackend('https://esplora.test/api/', stub)

describe('EsploraBackend', () => {
  it('reads outputs and confirmations (tip − height + 1); unknown txs are undefined', async () => {
    expect(await b.tx(TXID)).toEqual({ outputs: [{ script: SCRIPT, value: 10_000 }], confirmations: 3 })
    expect(await b.tx('00'.repeat(32))).toBeUndefined()
  })
  it('finds the spending input\'s witness through /outspend', async () => {
    expect(await b.spend(TXID, 0)).toEqual({ spent: true, witness: [[0x30], [0xde, 0xad], [0x01], [0xbe, 0xef]] })
  })
  it('median time, balance by reversed script hash, fee rate for the 3-block target or the next above', async () => {
    expect(await b.medianTime()).toBe(1_800_000_000)
    expect(await b.balance(SCRIPT)).toBe(1_000)
    expect(await b.feeRate()).toBe(3.5)
  })
  it('broadcast returns the txid, and surfaces the node\'s refusal', async () => {
    expect(await b.broadcast('0200')).toBe('ee'.repeat(32))
    await expect(b.broadcast('0201')).rejects.toThrow(/bad-txns/)
  })
})
