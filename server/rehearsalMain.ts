/**
 * npm run rehearse:agents: the zero-click rehearsal (server/rehearsal.ts) with the real brains:
 * Claude when ANTHROPIC_API_KEY is set (or AGENT_BRAIN/DONOR_BRAIN=claude-cli), the deterministic ones otherwise.
 * Offline on the mock chain; costs only model calls.
 */
import '../core/loadEnv'
import { defaultBrain } from '../fundraising-agent/brain'
import { defaultDonorBrain } from '../donor-agent/brain'
import { runRehearsal } from './rehearsal'

const fundBrain = defaultBrain(); const donorBrain = defaultDonorBrain()
console.log(`Zero-click rehearsal · fundraising brain ${fundBrain.name} · donor brain ${donorBrain.name}\n`)
const r = await runRehearsal({ fundBrain, donorBrain })
console.log('\nDonor agents:')
for (const d of r.donors) console.log(`  ${d.name}: pledged ${d.pledged.toLocaleString('en-US')} sats; votes ${d.votes.join(', ') || 'none'}; reclaimed ${d.refunds}${d.skipped.length > 0 ? `; skipped: ${d.skipped.join(' | ')}` : ''}`)
process.exit(r.status === 'completed' ? 0 : 1)
