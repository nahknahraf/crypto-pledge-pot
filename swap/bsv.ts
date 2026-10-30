/**
 * BSV side of a swap, through a BRC-100 wallet: lock sats in an AtomicSwap,
 * claim them with the secret, or refund them after the timeout. Keys are
 * derived in the wallet (never the identity key); the app computes sighashes
 * and the wallet signs, exactly like the escrow flows.
 */
import { Hash, Random, Signature, Transaction, TransactionSignature, Utils, type WalletInterface, type WalletProtocol } from '@bsv/sdk'
import { ALL_SCOPE, preimage } from '../core/pledge'
import { claimUnlock, swapLockingScript, swapRefundUnlock, swapUnlockLength, type SwapTerms } from '../core/swap'

export const SWAP_PROTOCOL: WalletProtocol = [1, 'cryptopledgepot swap']
export const SWAP_BASKET = 'cryptopledgepot swaps'
const NON_FINAL = 0xfffffffe
const hex = (b: number[] | Uint8Array): string => Utils.toHex(Array.from(b))
const outpointOf = (tx: Transaction, i: number): string => `${tx.inputs[i].sourceTXID ?? tx.inputs[i].sourceTransaction!.id('hex')}.${tx.inputs[i].sourceOutputIndex}`

/** Where a swap's sats are locked, with what is needed to spend them. */
export interface BsvLock { txid: string, vout: number, satoshis: number, terms: SwapTerms, beef: string }

export async function newSwapKey (wallet: WalletInterface): Promise<{ keyID: string, publicKey: string }> {
  const keyID = Utils.toHex(Random(16))
  const { publicKey } = await wallet.getPublicKey({ protocolID: SWAP_PROTOCOL, keyID, counterparty: 'self' })
  return { keyID, publicKey }
}

async function signInput (wallet: WalletInterface, tx: Transaction, i: number, keyID: string): Promise<number[]> {
  const { signature } = await wallet.createSignature({ hashToDirectlySign: Hash.hash256(preimage(tx, i, ALL_SCOPE)), protocolID: SWAP_PROTOCOL, keyID, counterparty: 'self' })
  const sig = Signature.fromDER([...signature])
  return new TransactionSignature(sig.r, sig.s, ALL_SCOPE).toChecksigFormat()
}

/** Lock `satoshis` in an AtomicSwap (the liquidity agent's side). */
export async function lockSats (wallet: WalletInterface, terms: SwapTerms, satoshis: number, senderKeyID: string): Promise<BsvLock> {
  const lockingScript = swapLockingScript(terms).toHex()
  const res = await wallet.createAction({
    description: 'Lock sats for a cross-chain swap',
    labels: ['cryptopledgepot', 'swap'],
    outputs: [{ lockingScript, satoshis, outputDescription: 'AtomicSwap lock', basket: SWAP_BASKET, customInstructions: JSON.stringify({ protocolID: SWAP_PROTOCOL, keyID: senderKeyID, role: 'sender' }), tags: ['swap'] }],
    options: { randomizeOutputs: false, acceptDelayedBroadcast: false }
  })
  if (res.tx === undefined || res.txid === undefined) throw new Error('wallet did not lock the sats')
  const vout = Transaction.fromAtomicBEEF(res.tx).outputs.findIndex(o => o.lockingScript.toHex() === lockingScript)
  return { txid: res.txid, vout, satoshis, terms, beef: hex(res.tx) }
}

/** Spend a swap lock (claim with the secret, or refund after the timeout); the sats land in the wallet as change. */
async function spendLock (wallet: WalletInterface, lock: BsvLock, keyID: string, path: { claim: string } | { refund: true }): Promise<{ txid: string, beef: string }> {
  const outpoint = `${lock.txid}.${lock.vout}`
  const scriptLen = swapLockingScript(lock.terms).toBinary().length
  const isClaim = 'claim' in path
  const created = await wallet.createAction({
    description: isClaim ? 'Claim swapped sats' : 'Refund a swap lock',
    labels: ['cryptopledgepot', 'swap'],
    inputBEEF: Utils.toArray(lock.beef, 'hex'),
    inputs: [{ outpoint, unlockingScriptLength: isClaim ? swapUnlockLength.claim() : swapUnlockLength.refund(scriptLen), inputDescription: 'AtomicSwap lock', sequenceNumber: isClaim ? undefined : NON_FINAL }],
    outputs: [],
    lockTime: isClaim ? undefined : lock.terms.refundAfter,
    options: { randomizeOutputs: false, acceptDelayedBroadcast: false }
  })
  const signable = created.signableTransaction
  if (signable === undefined) throw new Error('wallet did not return a signable transaction')
  const tx = Transaction.fromAtomicBEEF(signable.tx)
  const i = tx.inputs.findIndex((_, k) => outpointOf(tx, k) === outpoint)
  if (i < 0) { await wallet.abortAction({ reference: signable.reference }); throw new Error('swap input missing') }
  const sig = await signInput(wallet, tx, i, keyID)
  const unlockingScript = (isClaim ? claimUnlock(path.claim, sig) : swapRefundUnlock(sig, preimage(tx, i, ALL_SCOPE))).toHex()
  const signed = await wallet.signAction({ reference: signable.reference, spends: { [i]: { unlockingScript } }, options: { acceptDelayedBroadcast: false } })
  if (signed.txid === undefined || signed.tx === undefined) throw new Error('wallet did not complete the spend')
  return { txid: signed.txid, beef: hex(signed.tx) }
}

export const claimSats = async (wallet: WalletInterface, lock: BsvLock, receiverKeyID: string, secret: string) => await spendLock(wallet, lock, receiverKeyID, { claim: secret })
export const refundSats = async (wallet: WalletInterface, lock: BsvLock, senderKeyID: string) => await spendLock(wallet, lock, senderKeyID, { refund: true })

/** Who spent a BSV output? (Mock chain in tests and demos; WhatsOnChain's spent endpoint on mainnet.) */
export type SpendFinder = (txid: string, vout: number) => Promise<Transaction | undefined>
