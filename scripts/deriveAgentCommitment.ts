import { deriveAgentCommitment } from '../agent/zkAuth'

// Enrollment must use the same secret and circuit artifacts as the running
// agent. Read them from the environment so this helper never embeds credentials
// in source control or echoes them in its output.
const secret = process.env.AGENT_ZK_SECRET
const wasmPath = process.env.AGENT_ZK_WASM
const zkeyPath = process.env.AGENT_ZK_ZKEY

if (!secret || !wasmPath || !zkeyPath) {
  throw new Error('Set AGENT_ZK_SECRET, AGENT_ZK_WASM, and AGENT_ZK_ZKEY before enrollment')
}

// Print only the public Poseidon commitment. Configure this decimal signal on
// the provider as ZK_AGENT_COMMITMENT; the secret and generated proof stay local.
console.log(await deriveAgentCommitment({ secret, wasmPath, zkeyPath }))