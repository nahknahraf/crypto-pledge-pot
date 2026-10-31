/**
 * "Fund from an exchange": receive BSV from a sender that only knows how to pay
 * a plain address (an exchange withdrawal, an on-ramp), into the user's OWN
 * BRC-100 wallet. We never see exchange credentials; the user withdraws to the
 * address themselves.
 *
 * The address is a BRC-29 derived key with the well-known "anyone" counterparty
 * (private key 1): the exchange does not need to know BRC-29, and the wallet
 * can still recognise the payment and internalize it as a 'wallet payment'.
 * Never P2PKH(identityKey) (AGENTS.md): every address is a fresh derived key.
 * Keep the ReceiveAddress (prefix and suffix): it is needed to claim the payment.
 */
import { Beef, P2PKH, PrivateKey, PublicKey, Random, Transaction, Utils, type ChainTracker, type WalletInterface } from '@bsv/sdk'
import { BRC29_PROTOCOL } from './payments'

/** The public "anyone" key (private key 1), the counterparty for addresses anyone may pay. */
export const ANYONE_KEY = new PrivateKey(1).toPublicKey().toString()

export interface ReceiveAddress { address: string, lockingScript: string, derivationPrefix: string, derivationSuffix: string }

export async function newReceiveAddress (wallet: WalletInterface, network: 'main' | 'test' = 'main', originator?: string): Promise<ReceiveAddress> {
  const derivationPrefix = Utils.toBase64(Random(16))
  const derivationSuffix = Utils.toBase64(Random(16))
  const { publicKey } = await wallet.getPublicKey({ protocolID: BRC29_PROTOCOL, keyID: `${derivationPrefix} ${derivationSuffix}`, counterparty: ANYONE_KEY, forSelf: true }, originator)
  const key = PublicKey.fromString(publicKey)
  return {
    address: key.toAddress(network === 'test' ? 'testnet' : 'mainnet'),
    lockingScript: new P2PKH().lock(key.toAddress()).toHex(),
    derivationPrefix,
    derivationSuffix
  }
}

/**
 * Take every output of `atomicBeef` that pays `to` into the wallet. Checks SPV first (when a chain
 * tracker is given). Returns the sats received; 0 if the transaction pays this address nothing.
 */
export async function claimReceived (wallet: WalletInterface, to: ReceiveAddress, atomicBeef: number[], chainTracker?: ChainTracker, originator?: string): Promise<number> {
  const tx = Transaction.fromAtomicBEEF(atomicBeef)
  const indexes = tx.outputs.flatMap((o, i) => o.lockingScript.toHex() === to.lockingScript ? [i] : [])
  if (indexes.length === 0) return 0
  if (chainTracker !== undefined && !(await tx.verify(chainTracker).catch(() => false))) throw new Error('the payment failed SPV verification')
  await wallet.internalizeAction({
    tx: atomicBeef,
    outputs: indexes.map(outputIndex => ({ outputIndex, protocol: 'wallet payment' as const, paymentRemittance: { derivationPrefix: to.derivationPrefix, derivationSuffix: to.derivationSuffix, senderIdentityKey: ANYONE_KEY } })),
    description: 'Received to a deposit address'
  }, originator)
  return indexes.reduce((t, i) => t + (tx.outputs[i].satoshis ?? 0), 0)
}

/** Unspent payments to an address, from WhatsOnChain (txids; fetch each one's BEEF with wocBeef). */
export async function paymentsTo (address: string, network: 'main' | 'test' = 'main', fetchImpl: typeof fetch = fetch): Promise<string[]> {
  const res = await fetchImpl(`https://api.whatsonchain.com/v1/bsv/${network}/address/${address}/unspent`)
  if (!res.ok) throw new Error(`WhatsOnChain address lookup HTTP ${res.status}`)
  const list = await res.json() as Array<{ tx_hash: string }>
  return [...new Set(list.map(u => u.tx_hash))]
}

/** WhatsOnChain serves plain BEEF; claimReceived wants AtomicBEEF (BRC-95) for one txid. Accepts either. */
export function atomicBeefOf (beef: number[], txid: string): number[] {
  try { Transaction.fromAtomicBEEF(beef); return beef } catch { return Beef.fromBinary(beef).toBinaryAtomic(txid) }
}
