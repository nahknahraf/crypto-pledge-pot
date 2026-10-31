/**
 * npm run evm:verify: publish the deployed PriceGuardedHTLC's source on
 * Sourcify, so anyone can check that the bytecode at the recorded address is
 * built from evm/contracts/PriceGuardedHTLC.sol, and call checkedPrice with
 * their own signed response from a block explorer's "Read contract" tab
 * (Blockscout and Basescan show Sourcify-verified sources). No API key needed.
 *
 * Reads deployments/api3-price-guard.json and sends the exact Standard JSON
 * input evm/artifacts.json is compiled from (evm/compile.cjs standardInput),
 * so it needs evm/'s libraries: the npm script installs them first.
 */
import { createRequire } from 'node:module'
import { DEPLOYMENT_FILE, readDeployment } from './api3Proof'

const SOURCIFY = process.env.SOURCIFY_URL ?? 'https://sourcify.dev/server'
const d = readDeployment()
if (d === undefined) { console.error(`${DEPLOYMENT_FILE} not found: deploy first (npm run evm:deploy with BRIDGE_PRICE_GUARD=api3)`); process.exit(1) }

const { standardInput, compilerVersion } = createRequire(import.meta.url)('../evm/compile.cjs') as { standardInput: () => unknown, compilerVersion: () => string }
// Sourcify wants the plain long version, e.g. 0.8.38+commit.1835d247 (solc-js appends .Emscripten.clang).
const version = compilerVersion().replace(/\.Emscripten\.clang$/, '')

const sent = await fetch(`${SOURCIFY}/v2/verify/${d.chainId}/${d.address}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ stdJsonInput: standardInput(), compilerVersion: version, contractIdentifier: 'PriceGuardedHTLC.sol:PriceGuardedHTLC', creationTransactionHash: d.deployTx })
})
const body = await sent.json() as { verificationId?: string, customCode?: string, message?: string }
if (sent.status === 409) {
  console.log(`Already verified on Sourcify: https://repo.sourcify.dev/${d.chainId}/${d.address}`)
  process.exit(0)
}
if (!sent.ok || body.verificationId === undefined) { console.error(`Sourcify answered ${sent.status}: ${JSON.stringify(body)}`); process.exit(1) }

for (let i = 0; i < 60; i++) {
  await new Promise(resolve => setTimeout(resolve, 3000))
  const job = await (await fetch(`${SOURCIFY}/v2/verify/${body.verificationId}`)).json() as { isJobCompleted: boolean, contract?: { match?: string | null, creationMatch?: string | null, runtimeMatch?: string | null }, error?: { customCode?: string, message?: string } }
  if (!job.isJobCompleted) continue
  if (job.error !== undefined) { console.error(`Sourcify could not verify: ${job.error.customCode ?? ''} ${job.error.message ?? ''}`); process.exit(1) }
  console.log(`Verified on Sourcify (${job.contract?.match ?? 'match'}; creation ${job.contract?.creationMatch ?? '?'}, runtime ${job.contract?.runtimeMatch ?? '?'})`)
  console.log(`  source:   https://repo.sourcify.dev/${d.chainId}/${d.address}`)
  if (d.explorer !== undefined) console.log(`  explorer: ${d.explorer}`)
  process.exit(0)
}
console.error(`Sourcify is still working on it: ${SOURCIFY}/v2/verify/${body.verificationId}`)
process.exit(1)
