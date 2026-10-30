/**
 * Rebuild the index from chain: fetch transactions (with proofs) from
 * WhatsOnChain and hand them to the server's /api/import. Import a campaign's
 * anchor transaction before its pledge transactions.
 *
 *   npm run import -- <txid> [<txid> …]
 *
 * Env: CRYPTOPLEDGEPOT_URL (http://localhost:8787), NETWORK=main|test.
 * Read-only on chain: no wallet is involved.
 */
import { wocBeef } from '../client/cryptoPledgePot'
import { CryptoPledgePotApi } from '../client/cryptoPledgePotApi'

const api = new CryptoPledgePotApi(process.env.CRYPTOPLEDGEPOT_URL ?? 'http://localhost:8787')
const network = process.env.NETWORK === 'test' ? 'test' : 'main'
const txids = process.argv.slice(2).filter(a => /^[0-9a-f]{64}$/i.test(a))
if (txids.length === 0) { console.error('usage: npm run import -- <txid> [<txid> …]'); process.exit(1) }

for (const txid of txids) {
  try {
    const r = await api.importTx(await wocBeef(txid, network), txid)
    console.log(`${txid.slice(0, 12)}…  campaigns: ${r.campaigns.length}  pledges: ${r.pledges.length}${r.skipped.length > 0 ? `  skipped: ${r.skipped.join('; ')}` : ''}`)
  } catch (e) {
    console.error(`${txid.slice(0, 12)}…  failed: ${(e as Error).message}`)
  }
  await new Promise(resolve => setTimeout(resolve, 400)) // WhatsOnChain's free API rate limit
}
