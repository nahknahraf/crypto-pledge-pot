/**
 * The real other-chain half of a swap: an ERC-20 HTLC on an EVM chain, driven
 * with viem. It implements the same SourceChain interface as the simulated
 * ledger, so DonorSwap and LiquidityAgent run unchanged on Anvil (local),
 * Base Sepolia or Base.
 *
 * Contract: evm/contracts/HashedTimelockERC20.sol (compiled into
 * evm/artifacts.json by `node evm/compile.cjs`). Its hashlock is
 * sha256(secret), the same as the BSV AtomicSwap, so one secret ties both
 * chains together. The secret becomes public in the Claimed event, which is
 * how the liquidity agent learns it if it ever needs to.
 *
 * API3 price guard: with `priceGuarded`, the contract is a PriceGuardedHTLC.
 * Its lock is lockWithPrice: it also takes the sats the liquidity agent quoted
 * and a signed BSV/USD response from API3 AirnodeHub, and the contract refuses
 * the lock if the quote is more than its tolerance (e.g. 2%) away from that
 * price or the data is stale. See docs/API3_CROSSCHAIN_SWAP_GUARD.md.
 *
 * Keys: each account() needs a viem signer for that address. In this code
 * they are local accounts (Anvil's test keys or a testnet key from env). In a
 * browser the donor's own EVM wallet would sign instead (EIP-1193); see
 * docs/BRIDGING_PLAN.md.
 */
import { createPublicClient, createWalletClient, getAddress, http, parseEventLogs, toHex, type Abi, type Account, type Address, type Chain, type Hex, type PublicClient } from 'viem'
import artifacts from '../evm/artifacts.json'
import type { SignedResponse } from './api3Price'
import type { SourceAccount, SourceChain, SourceHtlc } from './usdcChain'

export const HTLC_ABI = artifacts.HashedTimelockERC20.abi as Abi
export const GUARDED_HTLC_ABI = artifacts.PriceGuardedHTLC.abi as Abi
export const TOKEN_ABI = artifacts.TestUSDC.abi as Abi

export interface EvmChainOptions {
  name: string
  rpcUrl: string
  chain: Chain
  /** HashedTimelockERC20 address. */
  htlc: Address
  /** The ERC-20 (6 decimals, like USDC). */
  token: Address
  /** Signers for the accounts this process may act for. */
  signers: Account[]
  /** Blocks to wait after each transaction (1 on Anvil, more on a public chain). */
  confirmations?: number
  /** The HTLC is a PriceGuardedHTLC: locks go through lockWithPrice with an API3 price proof. */
  priceGuarded?: boolean
}

const STATES = ['none', 'locked', 'claimed', 'refunded'] as const
const hex32 = (h: string): Hex => `0x${h.replace(/^0x/, '').padStart(64, '0')}`
const plain = (h: string): string => h.replace(/^0x/, '').toLowerCase()

export class EvmUsdcChain implements SourceChain {
  readonly name: string
  readonly client: PublicClient
  private readonly signers = new Map<string, Account>()

  constructor (readonly opts: EvmChainOptions) {
    this.name = opts.name
    this.client = createPublicClient({ chain: opts.chain, transport: http(opts.rpcUrl) })
    for (const a of opts.signers) this.signers.set(a.address.toLowerCase(), a)
  }

  async now (): Promise<number> {
    return Number((await this.client.getBlock({ blockTag: 'latest' })).timestamp)
  }

  async htlc (id: string): Promise<SourceHtlc | undefined> {
    const [sender, receiver, , amount, hashlock, refundAfter, state] = await this.client.readContract({ address: this.opts.htlc, abi: HTLC_ABI, functionName: 'locks', args: [hex32(id)] }) as [Address, Address, Address, bigint, Hex, bigint, number]
    if (state === 0) return undefined
    const h: SourceHtlc = { id, sender: getAddress(sender), receiver: getAddress(receiver), amount: Number(amount), hashlock: plain(hashlock), refundAfter: Number(refundAfter), state: STATES[state] as SourceHtlc['state'] }
    if (h.state === 'claimed') {
      const logs = await this.client.getContractEvents({ address: this.opts.htlc, abi: HTLC_ABI, eventName: 'Claimed', args: { id: hex32(id) }, fromBlock: 0n })
      const secret = (logs[0] as unknown as { args: { secret: Hex } } | undefined)?.args.secret
      if (secret !== undefined) h.secret = plain(secret)
    }
    return h
  }

  account (address: string): SourceAccount {
    const signer = this.signers.get(address.toLowerCase())
    const addr = getAddress(address)
    const write = async (to: Address, abi: Abi, functionName: string, args: unknown[]): Promise<Hex> => {
      if (signer === undefined) throw new Error(`${this.name}: no signer for ${addr}`)
      const wallet = createWalletClient({ account: signer, chain: this.opts.chain, transport: http(this.opts.rpcUrl) })
      // Simulate first: a revert comes back with the contract's reason instead of a failed transaction.
      const { request } = await this.client.simulateContract({ account: signer, address: to, abi, functionName, args })
      const hash = await wallet.writeContract(request)
      const receipt = await this.client.waitForTransactionReceipt({ hash, confirmations: this.opts.confirmations ?? 1 })
      if (receipt.status !== 'success') throw new Error(`${this.name}: ${functionName} reverted (tx ${hash})`)
      return hash
    }
    return {
      address: addr,
      balance: async () => Number(await this.client.readContract({ address: this.opts.token, abi: TOKEN_ABI, functionName: 'balanceOf', args: [addr] }) as bigint),
      lock: async ({ receiver, amount, hashlock, refundAfter, quotedSats, priceProof }) => {
        await write(this.opts.token, TOKEN_ABI, 'approve', [this.opts.htlc, BigInt(amount)])
        const base = [getAddress(receiver), this.opts.token, BigInt(amount), hex32(hashlock), BigInt(refundAfter)]
        const hash = this.opts.priceGuarded === true
          ? await write(this.opts.htlc, GUARDED_HTLC_ABI, 'lockWithPrice', [...base, ...priceArgs(quotedSats, priceProof)])
          // PriceGuardedHTLC's ABI is a superset of HashedTimelockERC20's (same lock selector), so a guarded
          // contract's UseLockWithPrice revert is decoded by name instead of as an unknown error.
          : await write(this.opts.htlc, GUARDED_HTLC_ABI, 'lock', base)
        const receipt = await this.client.getTransactionReceipt({ hash })
        const [locked] = parseEventLogs({ abi: HTLC_ABI, eventName: 'Locked', logs: receipt.logs }) as unknown as Array<{ args: { id: Hex } }>
        if (locked === undefined) throw new Error(`${this.name}: no Locked event in ${hash}`)
        return plain(locked.args.id)
      },
      claim: async (id, secret) => { await write(this.opts.htlc, HTLC_ABI, 'claim', [hex32(id), hex32(secret)]) },
      refund: async (id) => { await write(this.opts.htlc, HTLC_ABI, 'refund', [hex32(id)]) }
    }
  }
}

/** The extra lockWithPrice arguments: quoted sats, then the signed response (timestamp, data as bytes, signature). */
function priceArgs (quotedSats: number | undefined, p: SignedResponse | undefined): unknown[] {
  if (quotedSats === undefined || p === undefined) throw new Error('this HTLC checks the rate: the quote needs quotedSats and an API3 price proof (priceProof)')
  return [BigInt(quotedSats), BigInt(p.timestamp), toHex(p.data), p.signature]
}

/** Settings of a PriceGuardedHTLC (see evm/contracts/PriceGuardedHTLC.sol). */
export interface PriceGuardSettings {
  /** The Airnode's signing address (CoinPaprika's on AirnodeHub, or a local test key). */
  airnode: Address
  /** Hash of the accepted request (deriveRequestHash(BSV_USD_REQUEST)). */
  requestHash: Hex
  /** Largest allowed rate deviation in basis points (200 = 2%). */
  maxDeviationBps: number
  /** Longest age of the signed response, seconds. */
  maxResponseAge: number
  /** Longest age of the price observation, seconds. */
  maxPriceAge: number
  /** How the data writes updatedAt: 'iso' (CoinPaprika) or 'millis' (Nodary). */
  priceTime?: 'iso' | 'millis'
}

/** 2% tolerance, a response at most 5 minutes old, a price at most 15 minutes old (CoinPaprika updates every few minutes). */
export const DEFAULT_PRICE_GUARD: Omit<PriceGuardSettings, 'airnode' | 'requestHash'> = { maxDeviationBps: 200, maxResponseAge: 5 * 60, maxPriceAge: 15 * 60, priceTime: 'iso' }

/** Deploy the HTLC (price-guarded if `priceGuard` is given) and, for local tests, a TestUSDC token. */
export async function deployBridgeContracts (rpcUrl: string, chain: Chain, deployer: Account, opts: { withTestToken: boolean, priceGuard?: PriceGuardSettings }): Promise<{ htlc: Address, token?: Address }> {
  const client = createPublicClient({ chain, transport: http(rpcUrl) })
  const wallet = createWalletClient({ account: deployer, chain, transport: http(rpcUrl) })
  const deploy = async (c: { abi: unknown, bytecode: string }, args: unknown[] = []): Promise<Address> => {
    const hash = await wallet.deployContract({ abi: c.abi as Abi, bytecode: c.bytecode as Hex, args })
    const r = await client.waitForTransactionReceipt({ hash })
    if (r.contractAddress == null) throw new Error('deploy failed')
    return r.contractAddress
  }
  const g = opts.priceGuard
  const htlc = g === undefined
    ? await deploy(artifacts.HashedTimelockERC20)
    : await deploy(artifacts.PriceGuardedHTLC, [g.airnode, g.requestHash, BigInt(g.maxDeviationBps), BigInt(g.maxResponseAge), BigInt(g.maxPriceAge), 6, g.priceTime === 'millis' ? 1 : 0])
  const token = opts.withTestToken ? await deploy(artifacts.TestUSDC) : undefined
  return { htlc, token }
}

/** Mint TestUSDC (local chains only: anyone can mint it). */
export async function mintTestUsdc (rpcUrl: string, chain: Chain, minter: Account, token: Address, to: Address, amount: number): Promise<void> {
  const client = createPublicClient({ chain, transport: http(rpcUrl) })
  const wallet = createWalletClient({ account: minter, chain, transport: http(rpcUrl) })
  const hash = await wallet.writeContract({ address: token, abi: TOKEN_ABI, functionName: 'mint', args: [to, BigInt(amount)], chain })
  await client.waitForTransactionReceipt({ hash })
}
