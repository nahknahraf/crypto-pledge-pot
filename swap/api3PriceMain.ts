/**
 * npm run api3:price: show the API3 side of the price guard.
 *
 *  - Always: the request PriceGuardedHTLC accepts, its hash, and the Airnode
 *    address (what a deployment stores).
 *  - With API3_PAYER_KEY (a Base Sepolia TESTNET key holding aUSD from the
 *    AirnodeHub faucet): fetch a live BSV/USD response from CoinPaprika's
 *    Airnode, paying 0.001 aUSD with x402, verify its signature off-chain, and
 *    print it with the sats that 100 USDC are worth, ready for lockWithPrice.
 *
 * Needs evm/'s own dependencies for the x402 client: npm install --prefix evm.
 */
import type { Hex } from 'viem'
import { BSV_USD_REQUEST, COINPAPRIKA_AIRNODE_ADDRESS, COINPAPRIKA_AIRNODE_URL, createPayingFetch, deriveRequestHash, fetchBsvUsd, readPrice } from './api3Price'

console.log(`Airnode:      ${COINPAPRIKA_AIRNODE_URL} (signs as ${COINPAPRIKA_AIRNODE_ADDRESS})`)
console.log(`Request:      ${JSON.stringify(BSV_USD_REQUEST)}`)
console.log(`Request hash: ${deriveRequestHash(BSV_USD_REQUEST)}`)

const payer = process.env.API3_PAYER_KEY ?? ''
if (payer === '') {
  console.log('\nSet API3_PAYER_KEY (Base Sepolia testnet key with aUSD) to fetch a live, signed price.')
  process.exit(0)
}
const r = await fetchBsvUsd(await createPayingFetch(payer as Hex))
const { usd, updatedAt } = readPrice(r)
console.log(`\nSigned response (verified: right Airnode, right request):\n${JSON.stringify(r, null, 2)}`)
console.log(`\nBSV = $${usd} (taken ${new Date(updatedAt * 1000).toISOString()}): 100 USDC ≈ ${Math.floor((100 / usd) * 1e8).toLocaleString('en-US')} sats`)
