/**
 * npm run eval:agents: run the agent eval with the real brains (Claude when
 * ANTHROPIC_API_KEY is set, the deterministic ones otherwise), EVAL_RUNS times
 * (default 3), and write docs/AGENT_EVAL_RESULTS.md.
 */
import '../core/loadEnv'
import fs from 'node:fs'
import { defaultBrain } from '../fundraising-agent/brain'
import { defaultDonorBrain } from '../donor-agent/brain'
import { runAgentEval, toMarkdown, type EvalResult } from './agentEval'

const donorBrain = defaultDonorBrain()
const fundBrain = defaultBrain()
const runs = Number(process.env.EVAL_RUNS ?? 3)
const results: EvalResult[][] = []
for (let i = 0; i < runs; i++) {
  console.log(`[eval] run ${i + 1}/${runs} with ${donorBrain.name} and ${fundBrain.name}…`)
  results.push(await runAgentEval(donorBrain, fundBrain))
}
const md = toMarkdown(results, `donor ${donorBrain.name}, fundraising ${fundBrain.name}`)
fs.writeFileSync('docs/AGENT_EVAL_RESULTS.md', md)
console.log(md)
