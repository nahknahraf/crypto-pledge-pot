/**
 * The other chain, simulated: a USDC ledger with a standard HTLC contract.
 *
 * SIMULATED, on purpose: there is no local EVM in this environment. It
 * follows the rules of a standard ERC-20 HTLC exactly (lock / claim with the
 * secret before the timeout / refund after it), behind the `SourceChain`
 * interface a real adapter (viem + Base) would implement. Every action comes
 * from an account handle, like a wallet signer: you can only act as yourself.
 *
 * Amounts are integer micro-USDC (6 decimals, like USDC on Base).
 */
import { Hash, Utils } from '@bsv/sdk'

export interface SourceHtlc {
  id: string
  sender: string
  receiver: string
  amount: number
  hashlock: string
  refundAfter: number
  state: 'locked' | 'claimed' | 'refunded'
  /** Public once claimed: this is how the secret becomes visible on this chain. */
  secret?: string
  /** Blocks since the lock was mined (1 = in the latest block). Undefined on a ledger with no blocks (treated as final). */
  confirmations?: number
}

export interface SourceAccount {
  address: string
  balance: () => Promise<number>
  /** `request`: what the receiver asked to be paid, on chains where it acts first (`SourceChain.request`). */
  lock: (a: { receiver: string, amount: number, hashlock: string, refundAfter: number, request?: string }) => Promise<string>
  claim: (id: string, secret: string) => Promise<void>
  refund: (id: string) => Promise<void>
  /** Receiver only, where the chain allows it (Lightning): give a held lock back to the sender now. */
  release?: (id: string) => Promise<void>
}

/** What a source chain's amounts are: integer base units with `decimals` (USDC: 6; BTC: 8, i.e. satoshis). */
export interface SourceAsset { symbol: string, decimals: number }

export interface SourceChain {
  readonly name: string
  /** Defaults to USDC (6 decimals). Every amount on this chain, and a quote's `usdc` field, is in its base units. */
  readonly asset?: SourceAsset
  account: (address: string) => SourceAccount
  htlc: (id: string) => Promise<SourceHtlc | undefined>
  /** The chain's own time (unix seconds). Async: on a real chain it is a network call (the latest block). */
  now: () => Promise<number>
  /**
   * Only on chains where the RECEIVER acts first (Lightning: it issues a hold invoice for the donor's hashlock).
   * Returns what the sender passes to `lock` as `request`. Undefined elsewhere (EVM, BTC: the sender locks alone).
   */
  request?: (receiver: string, a: { amount: number, hashlock: string, refundAfter: number }) => Promise<string>
}

export const USDC = 1_000_000 // micro-USDC per USDC
export const formatUsdc = (micro: number): string => `${(micro / USDC).toFixed(2)} USDC`
export const assetOf = (c: SourceChain): SourceAsset => c.asset ?? { symbol: 'USDC', decimals: 6 }
/** Base units per whole unit (1 USDC = 1e6; 1 BTC = 1e8). */
export const unitOf = (c: SourceChain): number => 10 ** assetOf(c).decimals
export const formatAmount = (c: SourceChain, n: number): string => {
  const a = assetOf(c)
  return a.symbol === 'USDC' && a.decimals === 6 ? formatUsdc(n) : `${(n / 10 ** a.decimals).toFixed(a.decimals)} ${a.symbol}`
}

export class SimulatedUsdcChain implements SourceChain {
  readonly name = 'USDC (simulated Base ledger)'
  private readonly balances = new Map<string, number>()
  private readonly htlcs = new Map<string, SourceHtlc>()

  constructor (private readonly clock: () => number = () => Math.floor(Date.now() / 1000)) {}

  async now (): Promise<number> { return this.clock() }

  /** Test/demo faucet. */
  mint (address: string, amount: number): void {
    this.balances.set(address, (this.balances.get(address) ?? 0) + amount)
  }

  async htlc (id: string): Promise<SourceHtlc | undefined> {
    const h = this.htlcs.get(id)
    return h === undefined ? undefined : { ...h }
  }

  account (address: string): SourceAccount {
    const fail = (m: string): never => { throw new Error(`${this.name}: ${m}`) }
    return {
      address,
      balance: async () => this.balances.get(address) ?? 0,
      lock: async ({ receiver, amount, hashlock, refundAfter }) => {
        if (!Number.isSafeInteger(amount) || amount <= 0) fail('amount must be positive')
        if (!/^[0-9a-f]{64}$/.test(hashlock)) fail('hashlock must be 32 bytes hex')
        if (refundAfter <= this.clock()) fail('refund time must be in the future')
        if ((this.balances.get(address) ?? 0) < amount) fail('insufficient balance')
        this.balances.set(address, (this.balances.get(address) ?? 0) - amount)
        const id = `htlc-${this.htlcs.size + 1}`
        this.htlcs.set(id, { id, sender: address, receiver, amount, hashlock, refundAfter, state: 'locked' })
        return id
      },
      claim: async (id, secret) => {
        const h = this.htlcs.get(id) ?? fail('no such HTLC')
        if (h.state !== 'locked') fail(`HTLC is ${h.state}`)
        if (h.receiver !== address) fail('only the receiver can claim')
        if (this.clock() >= h.refundAfter) fail('too late to claim: the refund time has passed')
        if (!/^[0-9a-f]{64}$/.test(secret) || Utils.toHex(Hash.sha256(Utils.toArray(secret, 'hex'))) !== h.hashlock) fail('wrong secret')
        h.state = 'claimed'; h.secret = secret
        this.balances.set(address, (this.balances.get(address) ?? 0) + h.amount)
      },
      refund: async (id) => {
        const h = this.htlcs.get(id) ?? fail('no such HTLC')
        if (h.state !== 'locked') fail(`HTLC is ${h.state}`)
        if (h.sender !== address) fail('only the sender can refund')
        if (this.clock() < h.refundAfter) fail('refund time not reached')
        h.state = 'refunded'
        this.balances.set(address, (this.balances.get(address) ?? 0) + h.amount)
      }
    }
  }
}
