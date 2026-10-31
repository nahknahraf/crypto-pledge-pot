/**
 * Run the paid data API the agent buys from (BRC-121).
 *
 *   npm run data-provider
 *
 * Env: NETWORK=main|test, DATA_PORT=8790, DATA_PRICE_SATS=50, DATA_SOURCE=open-meteo|synthetic (default open-meteo),
 *      DATA_PROVIDER_KEY (else data/provider.key, generated once).
 * Payments land in this provider's own wallet-toolbox wallet.
 */
import path from 'node:path'
import { createDataProviderApp, serveDataProvider } from './dataProvider'
import { loadVerificationKey } from './zkAuth'
import { createToolboxWallet, loadOrCreateKey } from './wallet'

async function main (): Promise<void> {
  const chain = process.env.NETWORK === 'test' ? 'test' : 'main'
  const port = Number(process.env.DATA_PORT ?? 8790)
  const price = Number(process.env.DATA_PRICE_SATS ?? 50)
  const setup = await createToolboxWallet({
    chain,
    rootKey: loadOrCreateKey('DATA_PROVIDER_KEY', path.resolve('data', 'provider.key')),
    dbFile: path.resolve('data', 'provider-wallet.sqlite'),
    dbName: 'cryptopledgepot_provider'
  })
  let zkAuth
  // ZK authorization is opt-in to preserve existing local/demo deployments.
  // When enabled, both the expected public commitment and the verification
  // key are mandatory server-side configuration; the server never needs the
  // agent's secret or proving key.
  if (process.env.ZK_AGENT_AUTH === '1') {
    const commitment = process.env.ZK_AGENT_COMMITMENT
    const verificationKeyPath = process.env.ZK_VERIFICATION_KEY
    if (!commitment || !verificationKeyPath) {
      throw new Error('ZK_AGENT_COMMITMENT and ZK_VERIFICATION_KEY are required when ZK_AGENT_AUTH=1')
    }
    zkAuth = { commitment, verificationKey: await loadVerificationKey(verificationKeyPath) }
  }
  const source = process.env.DATA_SOURCE === 'synthetic' ? 'synthetic' : 'open-meteo'
  await serveDataProvider(createDataProviderApp(setup.wallet, price, {}, { source, zkAuth }), port)
  console.log(`[data] paid air-quality API on http://localhost:${port} · ${price} sats per call · source ${source}${zkAuth !== undefined ? ' · zk auth' : ''} · merchant ${setup.identityKey}`)
}

main().catch(e => { console.error(e); process.exit(1) })
