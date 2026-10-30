/**
 * Instant peer-to-peer payments (BRC-29) between BRC-100 wallets.
 *
 * The sender builds the transaction and hands the recipient an AtomicBEEF
 * (the transaction plus its ancestry back to merkle proofs) and the BRC-29
 * derivation data. The recipient verifies it with SPV and internalizes it; the
 * output is spendable immediately — no block confirmation needed.
 */
import { P2PKH, PublicKey, Random, Transaction, Utils, type ChainTracker, type WalletInterface, type WalletProtocol } from '@bsv/sdk'

/** BRC-29 payment protocol ID. */
export const BRC29_PROTOCOL: WalletProtocol = [2, '3241645161d8']

export interface Brc29Payment {
  /** AtomicBEEF (BRC-95) of the payment transaction. */
  tx: number[]
  txid: string
  outputIndex: number
  satoshis: number
  derivationPrefix: string
  derivationSuffix: string
  senderIdentityKey: string
}

/** Sender: pay `satoshis` to `recipientIdentityKey`. The wallet signs and broadcasts. */
export async function createBrc29Payment (
  wallet: WalletInterface,
  recipientIdentityKey: string,
  satoshis: number,
  description = 'BRC-29 payment',
  originator?: string
): Promise<Brc29Payment> {
  const derivationPrefix = Utils.toBase64(Random(16))
  const derivationSuffix = Utils.toBase64(Random(16))
  const { publicKey } = await wallet.getPublicKey({
    protocolID: BRC29_PROTOCOL,
    keyID: `${derivationPrefix} ${derivationSuffix}`,
    counterparty: recipientIdentityKey, // the OTHER party
    forSelf: false // derive the recipient's key, not ours
  }, originator)
  const lockingScript = new P2PKH().lock(PublicKey.fromString(publicKey).toAddress()).toHex()
  const res = await wallet.createAction({
    description,
    outputs: [{ lockingScript, satoshis, outputDescription: 'BRC-29 payment' }],
    options: { randomizeOutputs: false, acceptDelayedBroadcast: false }
  }, originator)
  if (res.txid === undefined || res.tx === undefined) throw new Error('payment was not completed by the wallet')
  const outputIndex = Transaction.fromAtomicBEEF(res.tx).outputs.findIndex(o => o.lockingScript.toHex() === lockingScript)
  if (outputIndex === -1) throw new Error('payment output not found in the transaction')
  const { publicKey: senderIdentityKey } = await wallet.getPublicKey({ identityKey: true }, originator)
  return { tx: Array.from(res.tx), txid: res.txid, outputIndex, satoshis, derivationPrefix, derivationSuffix, senderIdentityKey }
}

/**
 * Recipient: verify and accept a payment. With a `chainTracker` the SPV proof
 * is checked here before the wallet is asked anything (the wallet checks again
 * inside internalizeAction). Throws if the output is not really ours or not
 * worth what the sender claims.
 */
export async function acceptBrc29Payment (
  wallet: WalletInterface,
  p: Brc29Payment,
  chainTracker?: ChainTracker,
  description = 'Payment received',
  originator?: string
): Promise<void> {
  const tx = Transaction.fromAtomicBEEF(p.tx)
  if (chainTracker !== undefined && !(await tx.verify(chainTracker))) throw new Error('payment failed SPV verification')
  const { publicKey } = await wallet.getPublicKey({
    protocolID: BRC29_PROTOCOL,
    keyID: `${p.derivationPrefix} ${p.derivationSuffix}`,
    counterparty: p.senderIdentityKey, // the OTHER party
    forSelf: true // our own key
  }, originator)
  const expected = new P2PKH().lock(PublicKey.fromString(publicKey).toAddress()).toHex()
  const out = tx.outputs[p.outputIndex]
  if (out === undefined || out.lockingScript.toHex() !== expected) throw new Error('payment output is not locked to our key')
  if (out.satoshis !== p.satoshis) throw new Error(`payment is ${String(out.satoshis)} sats, not ${p.satoshis}`)
  await wallet.internalizeAction({
    tx: p.tx,
    outputs: [{
      outputIndex: p.outputIndex,
      protocol: 'wallet payment',
      paymentRemittance: {
        derivationPrefix: p.derivationPrefix,
        derivationSuffix: p.derivationSuffix,
        senderIdentityKey: p.senderIdentityKey
      }
    }],
    description
  }, originator)
}
