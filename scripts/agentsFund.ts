/**
 * npm run agents:fund: fund the zero-click run's agents from the team treasury (scripts/treasuryRun.ts).
 * One deposit, from any wallet or exchange, to the address it prints; then it pays every agent itself.
 * The agents must be running (npm run agents:mainnet starts them and runs this for you). NETWORK=main|test.
 */
import '../core/loadEnv'
import { runTreasury } from './treasuryRun'

const r = await runTreasury({ network: process.env.NETWORK === 'test' ? 'test' : 'main' })
process.exit(r === 'already funded' || r.every(x => x.ok) ? 0 : 1)
