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
 * Keys: each account() needs a viem signer for that address. In this code
 * they are local accounts (Anvil's test keys or a testnet key from env). In a
 * browser the donor's own EVM wallet would sign instead (EIP-1193); see
 * docs/BRIDGING_PLAN.md.
 */
import { createPublicClient, createWalletClient, getAddress, http, parseEventLogs, parseSignature, type Abi, type Account, type Address, type Chain, type Hex, type PublicClient, type Transport, type WalletClient } from 'viem'
import artifacts from '../evm/artifacts.json'
import type { SourceAccount, SourceChain, SourceHtlc } from './usdcChain'

export const HTLC_ABI = artifacts.HashedTimelockERC20.abi as Abi
export const TOKEN_ABI = artifacts.TestUSDC.abi as Abi

export interface EvmChainOptions {
  name: string
  rpcUrl: string
  chain: Chain
  /** HashedTimelockERC20 address. */
  htlc: Address
  /** The ERC-20 (6 decimals, like USDC). */
  token: Address
  /**
   * Signers for the accounts this process may act for: local accounts (a key in this process), or
   * JSON-RPC accounts ({ address, type: 'json-rpc' }) whose wallet signs, e.g. the donor's browser wallet.
   */
  signers: Account[]
  /** How transactions and signatures reach the signer: default http(rpcUrl); custom(window.ethereum) for a browser wallet (EIP-1193). */
  signerTransport?: Transport
  /** Blocks to wait after each transaction (1 on Anvil, more on a public chain). */
  confirmations?: number
  /** Lock with an EIP-2612 permit (one transaction) instead of approve + lock (two). The token must support it, as USDC does. */
  permit?: boolean
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
    const [locked] = await this.client.getContractEvents({ address: this.opts.htlc, abi: HTLC_ABI, eventName: 'Locked', args: { id: hex32(id) }, fromBlock: 0n })
    const minedIn = (locked as { blockNumber?: bigint | null } | undefined)?.blockNumber
    if (minedIn != null) h.confirmations = Number((await this.client.getBlockNumber({ cacheTime: 0 })) - minedIn) + 1 // no cache: viem keeps the block number for seconds
    if (h.state === 'claimed') {
      const logs = await this.client.getContractEvents({ address: this.opts.htlc, abi: HTLC_ABI, eventName: 'Claimed', args: { id: hex32(id) }, fromBlock: 0n })
      const secret = (logs[0] as unknown as { args: { secret: Hex } } | undefined)?.args.secret
      if (secret !== undefined) h.secret = plain(secret)
    }
    return h
  }

  /** The wallet client that signs for `signer`: in this process (local key) or in the user's wallet (EIP-1193). */
  private walletFor (signer: Account): WalletClient {
    return createWalletClient({ account: signer, chain: this.opts.chain, transport: this.opts.signerTransport ?? http(this.opts.rpcUrl) })
  }

  /** deadline, v, r, s of an EIP-2612 permit letting the HTLC pull `value` from `owner`. */
  private async permitSignature (signer: Account | undefined, owner: Address, value: bigint): Promise<[bigint, number, Hex, Hex]> {
    if (signer === undefined) throw new Error(`${this.name}: no signer for ${owner}`)
    const read = async (functionName: string, args: unknown[] = []): Promise<unknown> => await this.client.readContract({ address: this.opts.token, abi: TOKEN_ABI, functionName, args })
    const [name, version, nonce] = await Promise.all([read('name'), read('version'), read('nonces', [owner])]) as [string, string, bigint]
    const deadline = BigInt(await this.now()) + 3600n
    const signature = await this.walletFor(signer).signTypedData({
      account: signer,
      domain: { name, version, chainId: this.opts.chain.id, verifyingContract: this.opts.token },
      types: { Permit: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] },
      primaryType: 'Permit',
      message: { owner, spender: this.opts.htlc, value, nonce, deadline }
    })
    const { r, s, v } = parseSignature(signature)
    return [deadline, Number(v ?? 27n), r, s]
  }

  account (address: string): SourceAccount {
    const signer = this.signers.get(address.toLowerCase())
    const addr = getAddress(address)
    const write = async (to: Address, abi: Abi, functionName: string, args: unknown[]): Promise<Hex> => {
      if (signer === undefined) throw new Error(`${this.name}: no signer for ${addr}`)
      const wallet = this.walletFor(signer)
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
      lock: async ({ receiver, amount, hashlock, refundAfter }) => {
        const args = [getAddress(receiver), this.opts.token, BigInt(amount), hex32(hashlock), BigInt(refundAfter)]
        let hash: Hex
        if (this.opts.permit === true) {
          hash = await write(this.opts.htlc, HTLC_ABI, 'lockWithPermit', [...args, ...await this.permitSignature(signer, addr, BigInt(amount))])
        } else {
          await write(this.opts.token, TOKEN_ABI, 'approve', [this.opts.htlc, BigInt(amount)])
          hash = await write(this.opts.htlc, HTLC_ABI, 'lock', args)
        }
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

/** Deploy the HTLC and (for local tests) a TestUSDC token. Returns their addresses. */
export async function deployBridgeContracts (rpcUrl: string, chain: Chain, deployer: Account, opts: { withTestToken: boolean }): Promise<{ htlc: Address, token?: Address }> {
  const client = createPublicClient({ chain, transport: http(rpcUrl) })
  const wallet = createWalletClient({ account: deployer, chain, transport: http(rpcUrl) })
  const deploy = async (c: { abi: unknown, bytecode: string }): Promise<Address> => {
    const hash = await wallet.deployContract({ abi: c.abi as Abi, bytecode: c.bytecode as Hex, args: [] })
    const r = await client.waitForTransactionReceipt({ hash })
    if (r.contractAddress == null) throw new Error('deploy failed')
    return r.contractAddress
  }
  const htlc = await deploy(artifacts.HashedTimelockERC20)
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
