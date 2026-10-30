/**
 * 1Sat Ordinals NFTs on any BRC-100 wallet.
 *
 * An NFT is a 1-satoshi output. The inscription (content) is written once, at
 * mint; afterwards the NFT moves by spending that satoshi into another 1-sat
 * output. Ordinal theory tracks satoshis first-in-first-out, so a transfer
 * spends the NFT as input 0 and pays it to output 0.
 *
 * Keys: each NFT output is locked to a key derived with BRC-42
 * (protocol [1,'one sat ordinals'], random keyID, counterparty 'anyone'), never
 * to the identity key — a BRC-100 wallet cannot sign with its root key, so an
 * output locked to P2PKH(identityKey) could never be moved.
 *
 * Delivery: the sender hands the recipient an `OrdinalDelivery` (AtomicBEEF +
 * keyID) over any channel (MessageBox, WebSocket, HTTP); the recipient checks
 * it and `receive()`s it into the `ordinals` basket.
 */
import { Beef, P2PKH, Random, Transaction, Utils, type WalletInterface } from '@bsv/sdk'
import { anyonePkh, ORDINAL_PROTOCOL, ORDINALS_BASKET, type CustomInstructions } from '../core/addresses'
import { buildInscription, decodeInscription } from '../core/inscription'
import { P2PKH_UNLOCK_LENGTH, signWalletP2pkhInput } from './signer'

export interface OrdinalDelivery {
  /** AtomicBEEF of the transfer transaction. */
  tx: number[]
  txid: string
  outputIndex: number
  keyID: string
  senderIdentityKey: string
  /** Inscription id of the NFT (mint outpoint, `txid_vout`). */
  origin: string
  contentType?: string
}

export interface OwnedOrdinal {
  outpoint: string
  origin: string
  contentType?: string
  /** Present when this output still holds the inscription (i.e. we minted it and never moved it). */
  data?: number[]
}

const newKeyID = (): string => Utils.toHex(Random(16))

const instructions = (keyID: string): CustomInstructions => ({ protocolID: ORDINAL_PROTOCOL, keyID, counterparty: 'anyone' })

export class OrdinalKit {
  private identity?: string

  constructor (readonly wallet: WalletInterface, readonly originator?: string) {}

  async identityKey (): Promise<string> {
    this.identity ??= (await this.wallet.getPublicKey({ identityKey: true }, this.originator)).publicKey
    return this.identity
  }

  /** Inscribe `data` and keep the NFT in the `ordinals` basket. */
  async mint (contentType: string, data: number[] | string): Promise<{ txid: string, origin: string }> {
    const keyID = newKeyID()
    const lockingScript = buildInscription(contentType, data, anyonePkh(await this.identityKey(), keyID, ORDINAL_PROTOCOL))
    const res = await this.wallet.createAction({
      description: 'Mint 1Sat Ordinal NFT',
      labels: ['ordinals'],
      outputs: [{
        lockingScript: lockingScript.toHex(),
        satoshis: 1,
        outputDescription: `NFT ${contentType}`.slice(0, 50),
        basket: ORDINALS_BASKET,
        customInstructions: JSON.stringify(instructions(keyID)),
        tags: ['ordinal', `type:${contentType}`]
      }],
      // Keep the NFT at output 0 so its origin is `${txid}_0`.
      options: { randomizeOutputs: false, acceptDelayedBroadcast: false }
    }, this.originator)
    if (res.txid === undefined) throw new Error('mint was not completed by the wallet')
    return { txid: res.txid, origin: `${res.txid}_0` }
  }

  /** NFTs currently in the `ordinals` basket. */
  async list (): Promise<Array<OwnedOrdinal & { instructions: CustomInstructions, txid: string, vout: number }>> {
    const res = await this.wallet.listOutputs({
      basket: ORDINALS_BASKET,
      include: 'entire transactions',
      includeCustomInstructions: true,
      includeTags: true,
      limit: 1000
    }, this.originator)
    const beef = res.BEEF !== undefined && res.BEEF.length > 0 ? Beef.fromBinary(Array.from(res.BEEF)) : undefined
    return res.outputs.filter(o => o.customInstructions !== undefined).map(o => {
      const [txid, vout] = o.outpoint.split('.')
      const tags = o.tags ?? []
      const insc = decodeInscription(beef?.findTxid(txid)?.tx?.outputs[Number(vout)]?.lockingScript.toHex() ?? '')
      return {
        outpoint: o.outpoint,
        txid,
        vout: Number(vout),
        origin: tags.find(t => t.startsWith('origin:'))?.slice(7) ?? `${txid}_${vout}`,
        contentType: insc?.contentType ?? tags.find(t => t.startsWith('type:'))?.slice(5),
        data: insc?.data,
        instructions: JSON.parse(o.customInstructions!) as CustomInstructions
      }
    })
  }

  /** Transfer an NFT from the basket to `recipientIdentityKey`. Returns what the recipient needs. */
  async transfer (outpoint: string, recipientIdentityKey: string): Promise<OrdinalDelivery> {
    const owned = (await this.list()).find(o => o.outpoint === outpoint)
    if (owned === undefined) throw new Error(`NFT ${outpoint} is not in the ordinals basket`)
    const { BEEF } = await this.wallet.listOutputs({ basket: ORDINALS_BASKET, include: 'entire transactions', limit: 1000 }, this.originator)
    const keyID = newKeyID()
    const created = await this.wallet.createAction({
      description: 'Transfer 1Sat Ordinal NFT',
      labels: ['ordinals'],
      inputBEEF: BEEF !== undefined ? Array.from(BEEF) : undefined,
      inputs: [{ outpoint, unlockingScriptLength: P2PKH_UNLOCK_LENGTH, inputDescription: 'NFT input' }],
      outputs: [{
        lockingScript: new P2PKH().lock(Utils.toArray(anyonePkh(recipientIdentityKey, keyID, ORDINAL_PROTOCOL), 'hex')).toHex(),
        satoshis: 1,
        outputDescription: 'NFT to recipient'
      }],
      options: { randomizeOutputs: false, acceptDelayedBroadcast: false }
    }, this.originator)
    const signable = created.signableTransaction
    if (signable === undefined) throw new Error('wallet did not return a signable transaction')
    const tx = Transaction.fromAtomicBEEF(signable.tx)
    // First-in-first-out: the NFT satoshi must be input 0 and land in output 0.
    const [txid, vout] = outpoint.split('.')
    if ((tx.inputs[0].sourceTXID ?? tx.inputs[0].sourceTransaction?.id('hex')) !== txid || tx.inputs[0].sourceOutputIndex !== Number(vout)) {
      await this.wallet.abortAction({ reference: signable.reference }, this.originator)
      throw new Error('the wallet did not place the NFT at input 0; aborted so the ordinal is not moved to the wrong output')
    }
    if (tx.outputs[0].satoshis !== 1) {
      await this.wallet.abortAction({ reference: signable.reference }, this.originator)
      throw new Error('output 0 is not the 1-sat NFT output; aborted')
    }
    const unlockingScript = await signWalletP2pkhInput(this.wallet, tx, 0, owned.instructions, this.originator)
    const signed = await this.wallet.signAction({ reference: signable.reference, spends: { 0: { unlockingScript: unlockingScript.toHex() } }, options: { acceptDelayedBroadcast: false } }, this.originator)
    if (signed.txid === undefined || signed.tx === undefined) throw new Error('wallet did not complete the transfer')
    return {
      tx: Array.from(signed.tx),
      txid: signed.txid,
      outputIndex: 0,
      keyID,
      senderIdentityKey: await this.identityKey(),
      origin: owned.origin,
      contentType: owned.contentType
    }
  }

  /** Accept an NFT sent to us: check it is locked to our key, then add it to the basket. */
  async receive (d: OrdinalDelivery): Promise<void> {
    const tx = Transaction.fromAtomicBEEF(d.tx)
    const out = tx.outputs[d.outputIndex]
    const expected = new P2PKH().lock(Utils.toArray(anyonePkh(await this.identityKey(), d.keyID, ORDINAL_PROTOCOL), 'hex')).toHex()
    if (out === undefined || out.satoshis !== 1 || out.lockingScript.toHex() !== expected) {
      throw new Error('delivery output is not a 1-sat output locked to our key')
    }
    await this.wallet.internalizeAction({
      tx: d.tx,
      outputs: [{
        outputIndex: d.outputIndex,
        protocol: 'basket insertion',
        insertionRemittance: {
          basket: ORDINALS_BASKET,
          customInstructions: JSON.stringify(instructions(d.keyID)),
          tags: ['ordinal', `origin:${d.origin}`, ...(d.contentType !== undefined ? [`type:${d.contentType}`] : [])]
        }
      }],
      labels: ['ordinals'],
      description: 'Receive 1Sat Ordinal NFT'
    }, this.originator)
  }
}
