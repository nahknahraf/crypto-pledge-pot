/**
 * The Bitcoin (BTC) leg of the swap: a SourceChain backed by a Bitcoin Core node's RPC.
 *
 * Same contract as the EVM adapter, so LiquidityAgent and DonorSwap work unchanged:
 *  - an HTLC is a P2WSH output of swap/btc.ts's script. Its id is `txid:vout:witnessScriptHex`, which is
 *    self-verifying: anyone reading it checks that the output really pays sha256(script) and reads the
 *    terms (hashlock, receiver, sender, refundAfter) from the script itself;
 *  - an "address" is a compressed public key (hex); claims and refunds pay that key's P2WPKH output;
 *  - amounts are satoshis of BTC (asset BTC, 8 decimals);
 *  - now() is the chain's median time past, the clock OP_CHECKLOCKTIMEVERIFY uses (BIP 113).
 *
 * Locking needs a `funder`: the donor's own Bitcoin wallet paying the HTLC address (on regtest, the
 * node's wallet). Keys only sign claims and refunds here; nobody else's key is ever needed.
 * Reading spends uses the node: run it with -txindex (swap/bitcoind.ts does).
 */
import { Hash, PrivateKey, Utils } from '@bsv/sdk'
import { btcPublicKey, claimTx, htlcScript, p2wpkh, p2wsh, parseHtlcScript, refundTx, segwitAddress, serializeTx, witnessesOf, type BtcNetwork } from './btc'
import type { SourceAccount, SourceAsset, SourceChain, SourceHtlc } from './usdcChain'

export class BitcoindRpc {
  constructor (readonly url: string, private readonly user: string, private readonly password: string) {}
  async call<T = any>(method: string, params: unknown[] = [], wallet?: string): Promise<T> {
    const res = await fetch(wallet === undefined ? this.url : `${this.url}/wallet/${encodeURIComponent(wallet)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Basic ${Buffer.from(`${this.user}:${this.password}`).toString('base64')}` },
      body: JSON.stringify({ jsonrpc: '1.0', id: method, method, params })
    })
    const body = await res.json().catch(() => undefined) as { result: T, error: { message: string } | null } | undefined
    if (body === undefined) throw new Error(`bitcoind ${method}: HTTP ${res.status}`)
    if (body.error !== null) throw new Error(`bitcoind ${method}: ${body.error.message}`)
    return body.result
  }
}

/** Pays `sats` to `address` from the donor's Bitcoin wallet; returns the txid. */
export type BtcFunder = (address: string, sats: number) => Promise<string>

/** A funder backed by a wallet loaded in the node (regtest, or the donor's own node). */
export const bitcoindWalletFunder = (rpc: BitcoindRpc, wallet: string): BtcFunder =>
  async (address, sats) => await rpc.call<string>('sendtoaddress', [address, Number((sats / 1e8).toFixed(8))], wallet)

export interface BtcChainOptions {
  rpc: BitcoindRpc
  network: BtcNetwork
  /** Keys this process may sign with (claim/refund), like a wallet's accounts. */
  signers: PrivateKey[]
  /** Pays the HTLC address, for accounts that lock. */
  funder?: BtcFunder
  /** Miner fee for a claim or refund (sats). Default 1,000: ~5 sat/vB for this ~200 vB spend. */
  feeSats?: number
  name?: string
}

const sats = (btc: number): number => Math.round(btc * 1e8)

export class BtcChain implements SourceChain {
  readonly name: string
  readonly asset: SourceAsset = { symbol: 'BTC', decimals: 8 }
  private readonly rpc: BitcoindRpc

  constructor (private readonly o: BtcChainOptions) {
    this.rpc = o.rpc
    this.name = o.name ?? `Bitcoin (${o.network})`
  }

  async now (): Promise<number> {
    return (await this.rpc.call<{ mediantime: number }>('getblockchaininfo')).mediantime
  }

  /** Read an HTLC from the chain. Undefined if the id is malformed or the output is not that HTLC. */
  async htlc (id: string): Promise<SourceHtlc | undefined> {
    const parsed = parseId(id)
    if (parsed === undefined) return undefined
    const tx = await this.rpc.call<any>('getrawtransaction', [parsed.txid, true]).catch(() => undefined)
    const out = tx?.vout?.[parsed.vout]
    if (out === undefined || out.scriptPubKey.hex !== Utils.toHex(p2wsh(parsed.script))) return undefined
    const base = { id, sender: parsed.terms.sender, receiver: parsed.terms.receiver, amount: sats(out.value), hashlock: parsed.terms.hashlock, refundAfter: parsed.terms.refundAfter, confirmations: tx.confirmations ?? 0 }
    const unspent = await this.rpc.call<any>('gettxout', [parsed.txid, parsed.vout, true])
    if (unspent !== null) return { ...base, state: 'locked' }
    const spend = await this.findSpend(parsed.txid, parsed.vout, tx.blockhash)
    if (spend === undefined) return { ...base, state: 'locked' } // spent by something we can't see yet: treat as still open
    // Claim witness: <sig> <secret> 1 <script>; refund witness: <sig> <empty> <script>.
    return spend.length === 4 ? { ...base, state: 'claimed', secret: Utils.toHex(spend[1]) } : { ...base, state: 'refunded' }
  }

  /** The witness of the input spending txid:vout: the mempool first, then blocks from the lock's block on. */
  private async findSpend (txid: string, vout: number, fromBlock?: string): Promise<number[][] | undefined> {
    const match = (raw: string): number[][] | undefined => witnessesOf(raw).find(i => i.txid === txid && i.vout === vout)?.witness
    const pending = await this.rpc.call<Array<{ spendingtxid?: string }>>('gettxspendingprevout', [[{ txid, vout }]]).catch(() => [])
    if (pending[0]?.spendingtxid !== undefined) return match(await this.rpc.call<string>('getrawtransaction', [pending[0].spendingtxid]))
    if (fromBlock === undefined) return undefined
    let hash: string | undefined = fromBlock
    while (hash !== undefined) {
      const block: any = await this.rpc.call('getblock', [hash, 2])
      for (const t of block.tx) { const w = match(t.hex); if (w !== undefined) return w }
      hash = block.nextblockhash
    }
    return undefined
  }

  account (address: string): SourceAccount {
    const key = (): PrivateKey => {
      const k = this.o.signers.find(s => btcPublicKey(s) === address)
      if (k === undefined) throw new Error(`${this.name}: no key for ${address.slice(0, 12)}… in this process`)
      return k
    }
    const spendable = async (id: string): Promise<{ parsed: NonNullable<ReturnType<typeof parseId>>, value: number }> => {
      const parsed = parseId(id); const h = await this.htlc(id)
      if (parsed === undefined || h === undefined) throw new Error(`${this.name}: no such HTLC`)
      if (h.state !== 'locked') throw new Error(`${this.name}: HTLC is ${h.state}`)
      return { parsed, value: h.amount }
    }
    const fee = this.o.feeSats ?? 1_000
    return {
      address,
      /** Coins this key received from claims and refunds (its P2WPKH output), read from the UTXO set. */
      balance: async () => sats((await this.rpc.call<{ total_amount: number }>('scantxoutset', ['start', [`raw(${Utils.toHex(p2wpkh(address))})`]])).total_amount),
      lock: async ({ receiver, amount, hashlock, refundAfter }) => {
        if (this.o.funder === undefined) throw new Error(`${this.name}: no funder (a Bitcoin wallet) to lock with`)
        if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error(`${this.name}: amount must be positive`)
        const script = htlcScript({ hashlock, receiver, sender: address, refundAfter })
        const out = p2wsh(script)
        const txid = await this.o.funder(segwitAddress(out, this.o.network), amount)
        const tx = await this.rpc.call<any>('getrawtransaction', [txid, true])
        const vout = (tx.vout as Array<{ n: number, value: number, scriptPubKey: { hex: string } }>).find(v => v.scriptPubKey.hex === Utils.toHex(out) && sats(v.value) === amount)?.n
        if (vout === undefined) throw new Error(`${this.name}: the funding transaction does not pay the HTLC`)
        return `${txid}:${vout}:${Utils.toHex(script)}`
      },
      claim: async (id, secret) => {
        const { parsed, value } = await spendable(id)
        if (parsed.terms.receiver !== address) throw new Error(`${this.name}: only the receiver can claim`)
        if (!/^[0-9a-f]{64}$/.test(secret) || Utils.toHex(Hash.sha256(Utils.toArray(secret, 'hex'))) !== parsed.terms.hashlock) throw new Error(`${this.name}: wrong secret`)
        const tx = claimTx({ txid: parsed.txid, vout: parsed.vout, value, witnessScript: parsed.script, to: p2wpkh(address), fee }, key(), secret)
        await this.rpc.call('sendrawtransaction', [Utils.toHex(serializeTx(tx))])
      },
      refund: async (id) => {
        const { parsed, value } = await spendable(id)
        if (parsed.terms.sender !== address) throw new Error(`${this.name}: only the sender can refund`)
        // BIP 113: final only once the median time past is strictly after nLockTime.
        if ((await this.now()) <= parsed.terms.refundAfter) throw new Error(`${this.name}: refund too early: the timeout has not passed`)
        const tx = refundTx({ txid: parsed.txid, vout: parsed.vout, value, witnessScript: parsed.script, to: p2wpkh(address), fee }, key(), parsed.terms.refundAfter)
        await this.rpc.call('sendrawtransaction', [Utils.toHex(serializeTx(tx))])
      }
    }
  }
}

function parseId (id: string): { txid: string, vout: number, script: number[], terms: NonNullable<ReturnType<typeof parseHtlcScript>> } | undefined {
  const m = id.match(/^([0-9a-f]{64}):(\d{1,6}):([0-9a-f]{2,400})$/)
  if (m === null) return undefined
  const script = Utils.toArray(m[3], 'hex')
  const terms = parseHtlcScript(script)
  return terms === undefined ? undefined : { txid: m[1], vout: Number(m[2]), script, terms }
}
