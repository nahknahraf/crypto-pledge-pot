/**
 * The donor's side of the bridge in a browser: their own EVM wallet (MetaMask,
 * Coinbase Wallet… any EIP-1193 provider, i.e. window.ethereum) signs the USDC
 * lock. No EVM key ever enters CryptoPledgePot.
 *
 *   const { chain, address } = await connectBrowserEvm(window.ethereum, { name, rpcUrl, chain: baseSepolia, htlc, token, permit: true })
 *   new DonorSwap(bsvWallet, chain, address, chainTracker)
 */
import { custom, getAddress, type Address, type EIP1193Provider } from 'viem'
import { EvmUsdcChain, type EvmChainOptions } from './evmChain'

/** The part of an EIP-1193 provider we use. */
export type Eip1193 = Pick<EIP1193Provider, 'request'>

export async function connectBrowserEvm (provider: Eip1193, opts: Omit<EvmChainOptions, 'signers' | 'signerTransport'>): Promise<{ chain: EvmUsdcChain, address: Address }> {
  const [first] = await provider.request({ method: 'eth_requestAccounts' }) as Address[]
  if (first === undefined) throw new Error('the wallet shared no account')
  const chainId = Number(await provider.request({ method: 'eth_chainId' }))
  if (chainId !== opts.chain.id) {
    // Ask the wallet to switch; it may refuse, and then we stop rather than sign on the wrong chain.
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: `0x${opts.chain.id.toString(16)}` }] })
  }
  const address = getAddress(first)
  return { chain: new EvmUsdcChain({ ...opts, signers: [{ address, type: 'json-rpc' }], signerTransport: custom(provider as EIP1193Provider) }), address }
}
