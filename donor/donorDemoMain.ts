/** npm run demo:donor: the donor agent's two modes, narrated (offline; DEMO_PACE_S=2 by default). */
import { runDonorDemo } from './donorDemo'

await runDonorDemo({ paceMs: Number(process.env.DEMO_PACE_S ?? 2) * 1000 })
console.log('\nDone. Everything above ran offline on the mock chain with a deterministic brain (no API key needed).')
process.exit(0) // the mock chain's storage keeps timers alive
