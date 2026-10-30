/** npm run demo:swap: "Fay has only USDC", narrated (offline; DEMO_PACE_S=2 by default). */
import { runSwapDemo } from './swapDemo'

await runSwapDemo({ paceMs: Number(process.env.DEMO_PACE_S ?? 2) * 1000 })
console.log('\nDone. Everything above ran offline: real BSV scripts on the mock chain, a simulated USDC ledger.')
process.exit(0) // the mock chain's storage keeps timers alive
