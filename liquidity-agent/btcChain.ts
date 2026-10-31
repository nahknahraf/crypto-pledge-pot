/**
 * The Bitcoin (BTC) leg of the swap: a SourceChain over a Bitcoin data source (BtcBackend).
 *
 * Same contract as the EVM adapter, so LiquidityAgent and DonorSwap work unchanged:
 *  - an HTLC is a P2WSH output of liquidity-agent/btc.ts's script. Its id is `txid:vout:witnessScriptHex`, which is
 *    self-verifying: anyone reading it checks that the output really pays sha256(script) and reads the
 *    terms (hashlock, receiver, sender, refundAfter) from the script itself;
 *  - an "address" is a compressed public key (hex); claims and refunds pay that key's P2WPKH output;
 *  - amounts are satoshis of BTC (asset BTC, 8 decimals);
 *  - now() is the chain's median time past, the clock OP_CHECKLOCKTIMEVERIFY uses (BIP 113).
 *
 * Backends: `BitcoindBackend` (a node with -txindex: regtest, or your own node) and `EsploraBackend`
 * (the public Esplora HTTP API: blockstream.info, mempool.space; signet, testnet or mainnet).
 *
 * Locking needs a `funder`: the donor's own Bitcoin wallet paying the HTLC address (on regtest, the
 * node's wallet). Keys only sign claims and refunds here; nobody else's key is ever needed.
 */
import { Hash, PrivateKey, Utils } from '@bsv/sdk'
import { btcPublicKey, claimTx, decodeSegwitAddress, htlcScript, p2wpkh, p2wsh, parseHtlcScript, refundTx, segwitAddress, serializeTx, witnessesOf, type BtcNetwork, type BtcTx, type HtlcSpend } from './btc'
import type { SourceAccount, SourceAsset, SourceChain, SourceHtlc } from './usdcChain'

/** What BtcChain needs from the Bitcoin network. Every amount in sats; scripts and txs in hex. */
export interface BtcBackend {
  /** A transaction's outputs and confirmations (0 = in the mempool); undefined if unknown. */
  tx: (txid: string) => Promise<{ outputs: Array<{ script: string, value: number }>, confirmations: number } | undefined>
  /** Whether txid:vout is spent and, if so, the spending input's witness (undefined if not visible yet). */
  spend: (txid: string, vout: number) => Promise<{ spent: false } | { spent: true, witness?: number[][] }>
  /** Median time past of the tip (BIP 113). */
  medianTime: () => Promise<number>
  /** Sum of unspent outputs locked by this output script. */
  balance: (outputScriptHex: string) => Promise<number>
  /** Broadcast a raw transaction; returns its txid. */
  broadcast: (rawHex: string) => Promise<string>
  /** Fee rate for confirmation within a few blocks (sat/vB); undefined if the backend can't estimate. */
  feeRate: () => Promise<number | undefined>
  /** Unspent outputs locked by this output script (a node: confirmed only; Esplora: mempool too). */
  utxos: (outputScriptHex: string) => Promise<Array<{ txid: string, vout: number, value: number }>>
}

export class BitcoindRpc {
  constructor (readonly url: string, readonly user: string, private readonly password: string) {}
  /** For tools that must log in to the same node (LND's bitcoind backend). */
  get credentials (): { user: string, password: string } { return { user: this.user, password: this.password } }
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

const sats = (btc: number): number => Math.round(btc * 1e8)

/** A Bitcoin Core node over RPC. Needs -txindex (to read any transaction). */
export class BitcoindBackend implements BtcBackend {
  constructor (readonly rpc: BitcoindRpc) {}
  async tx (txid: string): Promise<{ outputs: Array<{ script: string, value: number }>, confirmations: number } | undefined> {
    const t = await this.rpc.call<any>('getrawtransaction', [txid, true]).catch(() => undefined)
    return t === undefined ? undefined : { outputs: t.vout.map((v: any) => ({ script: v.scriptPubKey.hex, value: sats(v.value) })), confirmations: t.confirmations ?? 0 }
  }

  async spend (txid: string, vout: number): Promise<{ spent: false } | { spent: true, witness?: number[][] }> {
    if (await this.rpc.call<any>('gettxout', [txid, vout, true]) !== null) return { spent: false }
    const match = (raw: string): number[][] | undefined => witnessesOf(raw).find(i => i.txid === txid && i.vout === vout)?.witness
    const pending = await this.rpc.call<Array<{ spendingtxid?: string }>>('gettxspendingprevout', [[{ txid, vout }]]).catch(() => [])
    if (pending[0]?.spendingtxid !== undefined) return { spent: true, witness: match(await this.rpc.call<string>('getrawtransaction', [pending[0].spendingtxid])) }
    // Confirmed: walk the blocks from the one that holds the lock.
    let hash: string | undefined = (await this.rpc.call<any>('getrawtransaction', [txid, true]).catch(() => undefined))?.blockhash
    while (hash !== undefined) {
      const block: any = await this.rpc.call('getblock', [hash, 2])
      for (const t of block.tx) { const w = match(t.hex); if (w !== undefined) return { spent: true, witness: w } }
      hash = block.nextblockhash
    }
    return { spent: true }
  }

  async medianTime (): Promise<number> { return (await this.rpc.call<{ mediantime: number }>('getblockchaininfo')).mediantime }
  async balance (script: string): Promise<number> { return sats((await this.rpc.call<{ total_amount: number }>('scantxoutset', ['start', [`raw(${script})`]])).total_amount) }
  async broadcast (raw: string): Promise<string> { return await this.rpc.call<string>('sendrawtransaction', [raw]) }
  async utxos (script: string): Promise<Array<{ txid: string, vout: number, value: number }>> {
    const r = await this.rpc.call<{ unspents: Array<{ txid: string, vout: number, amount: number }> }>('scantxoutset', ['start', [`raw(${script})`]])
    return r.unspents.map(u => ({ txid: u.txid, vout: u.vout, value: sats(u.amount) }))
  }
  async feeRate (): Promise<number | undefined> {
    const r = await this.rpc.call<{ feerate?: number }>('estimatesmartfee', [3]).catch(() => ({ feerate: undefined }))
    return r.feerate === undefined ? undefined : r.feerate * 1e8 / 1000 // BTC/kvB → sat/vB
  }
}

/** The Esplora HTTP API (https://github.com/Blockstream/esplora/blob/master/API.md), e.g. https://mempool.space/signet/api. */
export class EsploraBackend implements BtcBackend {
  constructor (readonly baseUrl: string, private readonly fetchImpl: typeof fetch = fetch) {}
  private async get (path: string): Promise<Response> { return await this.fetchImpl(`${this.baseUrl.replace(/\/$/, '')}${path}`) }
  private async json<T> (path: string): Promise<T> {
    const r = await this.get(path)
    if (!r.ok) throw new Error(`Esplora ${path}: HTTP ${r.status}`)
    return await r.json() as T
  }

  async tx (txid: string): Promise<{ outputs: Array<{ script: string, value: number }>, confirmations: number } | undefined> {
    const r = await this.get(`/tx/${txid}`)
    if (r.status === 404 || r.status === 400) return undefined
    if (!r.ok) throw new Error(`Esplora /tx: HTTP ${r.status}`)
    const t = await r.json() as { vout: Array<{ scriptpubkey: string, value: number }>, status: { confirmed: boolean, block_height?: number } }
    const tip = t.status.confirmed ? Number(await (await this.get('/blocks/tip/height')).text()) : 0
    return { outputs: t.vout.map(v => ({ script: v.scriptpubkey, value: v.value })), confirmations: t.status.confirmed ? tip - t.status.block_height! + 1 : 0 }
  }

  async spend (txid: string, vout: number): Promise<{ spent: false } | { spent: true, witness?: number[][] }> {
    const o = await this.json<{ spent: boolean, txid?: string, vin?: number }>(`/tx/${txid}/outspend/${vout}`)
    if (!o.spent) return { spent: false }
    if (o.txid === undefined || o.vin === undefined) return { spent: true }
    const t = await this.json<{ vin: Array<{ witness?: string[] }> }>(`/tx/${o.txid}`)
    return { spent: true, witness: t.vin[o.vin]?.witness?.map(w => Utils.toArray(w, 'hex')) }
  }

  async medianTime (): Promise<number> {
    const hash = await (await this.get('/blocks/tip/hash')).text()
    return (await this.json<{ mediantime: number }>(`/block/${hash.trim()}`)).mediantime
  }

  /** Esplora indexes by script hash: sha256 of the output script, byte-reversed. */
  async balance (script: string): Promise<number> {
    const sh = Utils.toHex(Hash.sha256(Utils.toArray(script, 'hex')).reverse())
    return (await this.json<Array<{ value: number }>>(`/scripthash/${sh}/utxo`)).reduce((t, u) => t + u.value, 0)
  }

  async utxos (script: string): Promise<Array<{ txid: string, vout: number, value: number }>> {
    const sh = Utils.toHex(Hash.sha256(Utils.toArray(script, 'hex')).reverse())
    return (await this.json<Array<{ txid: string, vout: number, value: number }>>(`/scripthash/${sh}/utxo`)).map(u => ({ txid: u.txid, vout: u.vout, value: u.value }))
  }

  async broadcast (raw: string): Promise<string> {
    const r = await this.fetchImpl(`${this.baseUrl.replace(/\/$/, '')}/tx`, { method: 'POST', body: raw })
    const text = (await r.text()).trim()
    if (!r.ok) throw new Error(`Esplora broadcast: ${text}`)
    return text
  }

  /** /fee-estimates maps a confirmation target (blocks) to sat/vB; take the 3-block target (or the nearest above). */
  async feeRate (): Promise<number | undefined> {
    const est = await this.json<Record<string, number>>('/fee-estimates').catch(() => ({} as Record<string, number>))
    const target = Object.keys(est).map(Number).filter(n => n >= 3).sort((a, b) => a - b)[0]
    return target === undefined ? undefined : est[String(target)]
  }
}

/**
 * Pays `sats` to `address` from the donor's Bitcoin wallet. Returns the txid, or nothing when the payment is
 * made elsewhere (any wallet, by hand): the lock then waits for an output paying the address that amount.
 */
export type BtcFunder = (address: string, sats: number) => Promise<string | undefined>

/** A funder backed by a wallet loaded in the node (regtest, or the donor's own node). */
export const bitcoindWalletFunder = (rpc: BitcoindRpc, wallet: string): BtcFunder =>
  async (address, sats) => await rpc.call<string>('sendtoaddress', [address, Number((sats / 1e8).toFixed(8))], wallet)

export interface BtcChainOptions {
  backend: BtcBackend
  network: BtcNetwork
  /** Keys this process may sign with (claim/refund), like a wallet's accounts. */
  signers: PrivateKey[]
  /** Pays the HTLC address, for accounts that lock. */
  funder?: BtcFunder
  /** A fixed miner fee for a claim or refund (sats). If unset: the backend's fee rate × the spend's size. */
  feeSats?: number
  /** Where a refund goes (a segwit address of the donor's own wallet); default the refunding key's P2WPKH. */
  refundTo?: string
  /** For a funder that returns no txid: how often and how long to look for the payment. Default 5 s, 1 hour. */
  fundingPollMs?: number
  fundingTimeoutMs?: number
  /** Floor and fallback rate (sat/vB) when estimating. Default 2. */
  minFeeRate?: number
  name?: string
}

/** Virtual size of a segwit transaction (BIP 141): (3 × base size + total size) / 4, rounded up. */
export const vsizeOf = (tx: BtcTx): number => Math.ceil((3 * serializeTx(tx, false).length + serializeTx(tx).length) / 4)

export class BtcChain implements SourceChain {
  readonly name: string
  readonly asset: SourceAsset = { symbol: 'BTC', decimals: 8 }
  private readonly backend: BtcBackend

  constructor (private readonly o: BtcChainOptions) {
    this.backend = o.backend
    this.name = o.name ?? `Bitcoin (${o.network})`
  }

  async now (): Promise<number> { return await this.backend.medianTime() }

  /** Read an HTLC from the chain. Undefined if the id is malformed or the output is not that HTLC. */
  async htlc (id: string): Promise<SourceHtlc | undefined> {
    const parsed = parseId(id)
    if (parsed === undefined) return undefined
    const tx = await this.backend.tx(parsed.txid)
    const out = tx?.outputs[parsed.vout]
    if (tx === undefined || out === undefined || out.script !== Utils.toHex(p2wsh(parsed.script))) return undefined
    const base = { id, sender: parsed.terms.sender, receiver: parsed.terms.receiver, amount: out.value, hashlock: parsed.terms.hashlock, refundAfter: parsed.terms.refundAfter, confirmations: tx.confirmations }
    const spend = await this.backend.spend(parsed.txid, parsed.vout)
    if (!spend.spent || spend.witness === undefined) return { ...base, state: 'locked' } // a spend we can't read yet: still open
    // Claim witness: <sig> <secret> 1 <script>; refund witness: <sig> <empty> <script>.
    return spend.witness.length === 4 ? { ...base, state: 'claimed', secret: Utils.toHex(spend.witness[1]) } : { ...base, state: 'refunded' }
  }

  /** Build a claim or refund with a fee from the backend's rate (or the fixed fee), sized from a first draft. */
  private async withFee (s: Omit<HtlcSpend, 'fee'>, build: (s: HtlcSpend) => BtcTx): Promise<BtcTx> {
    if (this.o.feeSats !== undefined) return build({ ...s, fee: this.o.feeSats })
    const rate = Math.max(this.o.minFeeRate ?? 2, (await this.backend.feeRate()) ?? 0)
    const fee = Math.ceil((vsizeOf(build({ ...s, fee: 0 })) + 1) * rate) // +1 vB: a signature may be a byte longer
    if (s.value - fee < 546) throw new Error(`${this.name}: the HTLC (${s.value} sats) is too small to spend at ${rate} sat/vB`)
    return build({ ...s, fee })
  }

  account (address: string): SourceAccount {
    const key = (): PrivateKey => {
      const k = this.o.signers.find(s => btcPublicKey(s) === address)
      if (k === undefined) throw new Error(`${this.name}: no key for ${address.slice(0, 12)}… in this process`)
      return k
    }
    const open = async (id: string): Promise<{ parsed: NonNullable<ReturnType<typeof parseId>>, value: number }> => {
      const parsed = parseId(id); const h = await this.htlc(id)
      if (parsed === undefined || h === undefined) throw new Error(`${this.name}: no such HTLC`)
      if (h.state !== 'locked') throw new Error(`${this.name}: HTLC is ${h.state}`)
      return { parsed, value: h.amount }
    }
    return {
      address,
      /** Coins this key received from claims and refunds (its P2WPKH output). */
      balance: async () => await this.backend.balance(Utils.toHex(p2wpkh(address))),
      lock: async ({ receiver, amount, hashlock, refundAfter }) => {
        if (this.o.funder === undefined) throw new Error(`${this.name}: no funder (a Bitcoin wallet) to lock with`)
        if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error(`${this.name}: amount must be positive`)
        const script = htlcScript({ hashlock, receiver, sender: address, refundAfter })
        const out = Utils.toHex(p2wsh(script))
        const txid = await this.o.funder(segwitAddress(p2wsh(script), this.o.network), amount)
        if (txid === undefined) { // paid from elsewhere: find the output on chain
          const end = Date.now() + (this.o.fundingTimeoutMs ?? 3_600_000)
          for (;;) {
            const u = (await this.backend.utxos(out)).find(x => x.value === amount)
            if (u !== undefined) return `${u.txid}:${u.vout}:${Utils.toHex(script)}`
            if (Date.now() > end) throw new Error(`${this.name}: no payment of ${amount} sats to the HTLC address arrived`)
            await new Promise(r => setTimeout(r, this.o.fundingPollMs ?? 5_000))
          }
        }
        let tx = await this.backend.tx(txid)
        for (let i = 0; tx === undefined && i < 10; i++) { await new Promise(r => setTimeout(r, 1000)); tx = await this.backend.tx(txid) } // an indexer may lag
        const vout = tx?.outputs.findIndex(v => v.script === out && v.value === amount) ?? -1
        if (vout < 0) throw new Error(`${this.name}: the funding transaction does not pay the HTLC`)
        return `${txid}:${vout}:${Utils.toHex(script)}`
      },
      claim: async (id, secret) => {
        const { parsed, value } = await open(id)
        if (parsed.terms.receiver !== address) throw new Error(`${this.name}: only the receiver can claim`)
        if (!/^[0-9a-f]{64}$/.test(secret) || Utils.toHex(Hash.sha256(Utils.toArray(secret, 'hex'))) !== parsed.terms.hashlock) throw new Error(`${this.name}: wrong secret`)
        const tx = await this.withFee({ txid: parsed.txid, vout: parsed.vout, value, witnessScript: parsed.script, to: p2wpkh(address) }, s => claimTx(s, key(), secret))
        await this.backend.broadcast(Utils.toHex(serializeTx(tx)))
      },
      refund: async (id) => {
        const { parsed, value } = await open(id)
        if (parsed.terms.sender !== address) throw new Error(`${this.name}: only the sender can refund`)
        // BIP 113: final only once the median time past is strictly after nLockTime.
        if ((await this.now()) <= parsed.terms.refundAfter) throw new Error(`${this.name}: refund too early: the timeout has not passed`)
        const tx = await this.withFee({ txid: parsed.txid, vout: parsed.vout, value, witnessScript: parsed.script, to: this.o.refundTo !== undefined ? decodeSegwitAddress(this.o.refundTo, this.o.network) : p2wpkh(address) }, s => refundTx(s, key(), parsed.terms.refundAfter))
        await this.backend.broadcast(Utils.toHex(serializeTx(tx)))
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
