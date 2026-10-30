/**
 * Payment plan, end to end on the mock chain (real wallets, real server, SPV):
 * the NGO signs its plan into the campaign, pays a vendor from a released
 * milestone and proves it, and reports an auditor-signed invoice. Payments
 * to the wrong payee, reused payments and unsigned invoices do not count.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import { P2PKH, PrivateKey, Utils } from '@bsv/sdk'
import type { Wallet } from '@bsv/wallet-toolbox'
import { CryptoPledgePot, type LaunchInput } from '../client/cryptoPledgePot'
import { CryptoPledgePotApi } from '../client/cryptoPledgePotApi'
import { paymentPlanSigned } from '../core/campaign'
import { AUDIT_PROTOCOL, auditMessage, defaultLegalTerms, type PaymentPlan } from '../core/paymentPlan'
import { createCryptoPledgePotApp } from '../server/app'
import { CryptoPledgePotDb } from '../server/db'
import { createMockChain, memoryKnex, type MockChain } from './helpers/mockchain'

const T0 = Math.floor(Date.now() / 1000) - 60 * 86_400
const DAY = 86_400
let clock = T0
let chain: MockChain, server: Server, url: string
let ngo: Wallet, donor: Wallet, auditor: Wallet
const as = (w: Wallet): CryptoPledgePot => new CryptoPledgePot(w, new CryptoPledgePotApi(url, w))
const vendorScript = new P2PKH().lock(PrivateKey.fromRandom().toAddress()).toHex()

const planFor = (auditorKey: string): PaymentPlan => ({
  v: 1, tolerancePercent: 10, reportDays: 30, graceDays: 7, auditorKey, legalTerms: defaultLegalTerms(),
  milestones: [
    { lines: [{ id: 'm1-filters', category: 'Water filters', percent: 70, payee: { kind: 'onchain', name: 'AquaPure Ltd', lockingScript: vendorScript } }, { id: 'm1-staff', category: 'Field staff', percent: 30, payee: { kind: 'offchain', name: 'Staff payroll' } }] },
    { lines: [{ id: 'm2-install', category: 'Installation', percent: 100, payee: { kind: 'onchain', name: 'AquaPure Ltd', lockingScript: vendorScript } }] }
  ]
})
const launchInput = (plan: PaymentPlan): LaunchInput => ({
  title: 'Clean water for Kitui schools', description: 'Ceramic filters for three schools, installed by AquaPure.',
  goal: 10_000, deadline: clock + 3_600, refundAfter: clock + 90 * DAY,
  milestones: [{ title: 'Buy filters and train staff', percent: 50 }, { title: 'Install the filters', percent: 50 }],
  paymentPlan: plan
})

beforeAll(async () => {
  chain = await createMockChain()
  const db = new CryptoPledgePotDb(memoryKnex()); await db.migrate()
  const arbiter = await chain.makeWallet()
  await new Promise<void>(resolve => { server = createCryptoPledgePotApp({ wallet: arbiter, db, chainTracker: chain.chainTracker, now: () => clock }).listen(0, () => resolve()) })
  url = `http://127.0.0.1:${(server.address() as any).port}`
  ;[ngo, donor, auditor] = [await chain.makeWallet(), await chain.makeWallet(), await chain.makeWallet()]
  await chain.fund(ngo, 50_000)
  await chain.fund(donor, 50_000)
}, 120_000)
afterAll(async () => { await new Promise(r => server?.close(r)); await chain?.close() })

describe('an NGO bound by its payment plan', () => {
  let campaignId: string
  let auditorKey: string

  it('the plan is signed by the NGO and fixed into the campaign', async () => {
    auditorKey = (await auditor.getPublicKey({ identityKey: true })).publicKey
    const launched = await as(ngo).launch(launchInput(planFor(auditorKey)))
    campaignId = launched.campaignId
    const c = await new CryptoPledgePotApi(url).campaign(campaignId)
    expect(c.meta.paymentPlan?.milestones[0].lines.map(l => l.id)).toEqual(['m1-filters', 'm1-staff'])
    expect(await paymentPlanSigned(c.meta)).toBe(true)
  })

  it('the server refuses a campaign whose plan was changed after signing', async () => {
    const { meta } = await new CryptoPledgePotApi(url).campaign(campaignId)
    const tampered = { ...meta, nonce: '0123456789abcdef0123456789abcdef', createdAt: meta.createdAt + 1, paymentPlan: { ...meta.paymentPlan!, tolerancePercent: 25 } }
    tampered.arbiterKey = await new CryptoPledgePotApi(url).arbiterKey(tampered.nonce)
    await expect(new CryptoPledgePotApi(url, ngo).registerCampaign(tampered, '00')).rejects.toThrow(/not signed by the creator/)
  })

  it('spending can only be reported once a milestone is released', async () => {
    await as(donor).donate((await new CryptoPledgePotApi(url).campaign(campaignId)).meta, 10_000)
    await expect(as(ngo).payPlanLine(campaignId, 1, 'm1-filters', 3_500)).rejects.toThrow(/not been released yet/)
  })

  it('the NGO pays the vendor from milestone 1 and the payment is verified by SPV', async () => {
    clock += 3_601
    const r = await as(ngo).release(campaignId)
    expect(r).toMatchObject({ milestone: 1, released: 5_000 })
    const { spending } = await as(ngo).payPlanLine(campaignId, 1, 'm1-filters', 3_400, 'Invoice AP-0042')
    expect(spending.lines[0]).toMatchObject({ lineId: 'm1-filters', plannedSats: 3_500, spentSats: 3_400, withinTolerance: true })
    expect(spending).toMatchObject({ ok: false, unaccountedSats: 5_000 - 3_400 }) // payroll still missing
  })

  it('an off-chain invoice counts once the auditor has signed it', async () => {
    const invoiceSha256 = 'ef'.repeat(32)
    const unsigned = { lineId: 'm1-staff', sats: 1_500, invoiceSha256, attestation: '30' + '00'.repeat(40) }
    await expect(as(ngo).reportSpending(campaignId, 1, [unsigned])).rejects.toThrow(/not signed by the plan's auditor/)
    const { signature } = await auditor.createSignature({
      data: Utils.toArray(auditMessage(campaignId, 1, 'm1-staff', 1_500, invoiceSha256), 'utf8'), protocolID: AUDIT_PROTOCOL, keyID: campaignId, counterparty: 'anyone'
    })
    const spending = await as(ngo).reportSpending(campaignId, 1, [{ ...unsigned, attestation: Utils.toHex(signature) }])
    expect(spending).toMatchObject({ ok: true, unaccountedSats: 0 })
    expect((await new CryptoPledgePotApi(url).campaign(campaignId)).milestones[0].spending?.ok).toBe(true)
  })

  it('a payment to someone else, or one reported twice, does not count', async () => {
    const elsewhere = new P2PKH().lock(PrivateKey.fromRandom().toAddress()).toHex()
    const res = await ngo.createAction({ description: 'Pay a friend', outputs: [{ lockingScript: elsewhere, satoshis: 900, outputDescription: 'friend' }], options: { randomizeOutputs: false, acceptDelayedBroadcast: false } })
    const beef = Utils.toHex(res.tx!)
    await expect(as(ngo).reportSpending(campaignId, 1, [{ lineId: 'm1-filters', beef, vout: 0 }])).rejects.toThrow(/does not go to AquaPure Ltd/)

    const spends = await new CryptoPledgePotApi(url).spends(campaignId)
    const [txid, vout] = spends.find(s => s.lineId === 'm1-filters')!.outpoint!.split('.')
    const original = (await new CryptoPledgePotApi(url).txBeef(txid))
    await expect(as(ngo).reportSpending(campaignId, 1, [{ lineId: 'm1-filters', beef: original, vout: Number(vout) }])).rejects.toThrow(/already reported/)
  })

  it('only the creator reports spending', async () => {
    await expect(as(donor).reportSpending(campaignId, 1, [{ lineId: 'm1-filters' }])).rejects.toThrow(/only the creator/)
  })
})
