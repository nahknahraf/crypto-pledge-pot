/**
 * Run the compliance agent: npm run compliance
 *
 * It reads the CryptoPledgePot index, follows every campaign with a payment
 * plan, and publishes its notices at GET /api/compliance. With a funded wallet
 * (data/compliance.key) it also writes breach records on chain; it needs only
 * a few hundred sats for that.
 *
 * Env: CRYPTOPLEDGEPOT_URL (http://localhost:8787), NETWORK=main|test,
 *      COMPLIANCE_PORT (8793), COMPLIANCE_HOST (127.0.0.1),
 *      COMPLIANCE_INTERVAL_S (300), COMPLIANCE_NOTIFY_URL (optional webhook:
 *      every notice is POSTed there as JSON), COMPLIANCE_ROOT_KEY,
 *      COMPLIANCE_ANCHOR=0 to never write on chain.
 */
import path from 'node:path'
import express from 'express'
import { CryptoPledgePotApi } from '../client/cryptoPledgePotApi'
import { breachRecordScript } from '../core/campaign'
import { fileStore } from '../agent/ledger'
import { createToolboxWallet, loadOrCreateKey } from '../agent/wallet'
import { ComplianceAgent, EMPTY_STATE, type ComplianceAgentState, type ComplianceStepSummary } from './complianceAgent'

const network = process.env.NETWORK === 'test' ? 'test' : 'main'
const dataDir = path.resolve('data')
const serverUrl = process.env.CRYPTOPLEDGEPOT_URL ?? 'http://localhost:8787'
const notifyUrl = process.env.COMPLIANCE_NOTIFY_URL

const health = await new CryptoPledgePotApi(serverUrl).health()
const anchorOnChain = process.env.COMPLIANCE_ANCHOR !== '0' && health.network !== 'mock'
const wallet = anchorOnChain
  ? (await createToolboxWallet({
      chain: network,
      rootKey: loadOrCreateKey('COMPLIANCE_ROOT_KEY', path.join(dataDir, 'compliance.key')),
      dbFile: path.join(dataDir, 'compliance-wallet.sqlite'),
      dbName: 'cryptopledgepot_compliance'
    })).wallet
  : undefined

const agent = new ComplianceAgent({
  api: new CryptoPledgePotApi(serverUrl),
  store: fileStore<ComplianceAgentState>(path.join(dataDir, 'compliance-state.json'), EMPTY_STATE),
  anchor: wallet === undefined
    ? undefined
    : async (campaignId, record) => {
      const res = await wallet.createAction({
        description: 'CryptoPledgePot breach record',
        labels: ['cryptopledgepot', 'compliance'],
        outputs: [{ lockingScript: breachRecordScript(campaignId, record).toHex(), satoshis: 0, outputDescription: 'Payment plan breach record' }],
        options: { randomizeOutputs: false, acceptDelayedBroadcast: false }
      })
      if (res.txid === undefined) throw new Error('wallet did not return the breach record transaction')
      return res.txid
    },
  notify: notifyUrl === undefined
    ? undefined
    : async (n) => {
      const res = await fetch(notifyUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(n) })
      if (!res.ok) throw new Error(`webhook answered HTTP ${res.status}`)
    }
})

let last: ComplianceStepSummary | undefined
const app = express()
app.get('/api/compliance', (_req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.json({ server: serverUrl, anchoring: wallet !== undefined, lastStep: last ?? null, notices: [...agent.notices()].reverse() })
})
const port = Number(process.env.COMPLIANCE_PORT ?? 8793)
const host = process.env.COMPLIANCE_HOST ?? '127.0.0.1'
app.listen(port, host, () => {
  console.log(`[compliance] watching ${serverUrl} · breach records ${wallet !== undefined ? 'on chain' : 'off'} · http://${host}:${port}/api/compliance`)
  if (wallet !== undefined) void wallet.getPublicKey({ identityKey: true }).then(k => console.log(`[compliance] fund this identity for breach records: ${k.publicKey}`))
})
const intervalMs = Number(process.env.COMPLIANCE_INTERVAL_S ?? 300) * 1000
for (;;) {
  try { last = await agent.step(); console.log(`[compliance] round: ${JSON.stringify(last)}`) } catch (e) { console.error(`[compliance] round failed: ${(e as Error).message}`) }
  await new Promise(resolve => setTimeout(resolve, intervalMs))
}
