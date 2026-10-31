/**
 * npm run demo:agent: the "AirWatch live" story (offline mock chain, wallets
 * disabled). Open the web app (npm run app / share, or Docker) while it plays.
 *
 * Env: DEMO_PACE_S (6), PORT (8787), DATA_PORT (8790), AGENT_PORT (8791),
 *      AGENT_PUBLIC_URL (the agent's public status URL when shared).
 */
import '../core/loadEnv'
import { defaultBrain } from '../agent/brain'
import { runAgentDemo } from './agentDemo'

const demo = await runAgentDemo({
  port: Number(process.env.PORT ?? 8787),
  dataPort: Number(process.env.DATA_PORT ?? 8790),
  agentPort: Number(process.env.AGENT_PORT ?? 8791),
  paceMs: Number(process.env.DEMO_PACE_S ?? 6) * 1000,
  agentPublicUrl: process.env.AGENT_PUBLIC_URL,
  brain: defaultBrain()
})
console.log(`[demo] AirWatch live on ${demo.url}: open the web app and watch the agent campaign`)
demo.done.then(
  () => console.log('[demo] story complete. Everything stays browsable; Ctrl+C to stop, run again to replay.'),
  e => console.error(`[demo] story stopped: ${(e as Error).message}`)
)
