/**
 * Find campaigns from the terminal: npm run donor:search -- children in need
 *
 * Read-only: no wallet, no mandate. Env: CRYPTOPLEDGEPOT_URL
 * (http://localhost:8787), ANTHROPIC_API_KEY (Claude ranks and summarises;
 * otherwise the offline keyword brain).
 */
import { CryptoPledgePotApi } from '../client/cryptoPledgePotApi'
import { defaultSearchBrain, formatSearch, searchCampaigns } from './search'

const query = process.argv.slice(2).filter(a => a !== '--').join(' ')
if (query.trim() === '') {
  console.error('Say what you want to support, e.g.: npm run donor:search -- children in need')
  process.exit(1)
}
const api = new CryptoPledgePotApi(process.env.CRYPTOPLEDGEPOT_URL ?? 'http://localhost:8787')
const { now } = await api.health()
console.log(formatSearch(await searchCampaigns(query, await api.campaigns(), defaultSearchBrain(), { now })))
