import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { RequestHandler } from 'express'
import { groth16 } from 'snarkjs'

export const ZK_PROOF_HEADER = 'x-zk-proof'
export const ZK_SIGNALS_HEADER = 'x-zk-signals'

// Circom's default Groth16 curve is BN254. Private witness values must be valid
// elements of this curve's scalar field before they are passed to the circuit.
const BN254_SCALAR_FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n
// Proof JSON and public-signal JSON arrive in HTTP headers. Bound each header
// before parsing it so malformed requests cannot force unbounded JSON parsing.
const MAX_HEADER_LENGTH = 16_384

export interface AgentProofOptions {
  /** High-entropy authorization token; never include this value in an HTTP request. */
  secret: string
  /** Circom-generated witness calculator for the compiled circuit. */
  wasmPath: string
  /** Groth16 proving key generated for that exact circuit. */
  zkeyPath: string
}

export interface AgentAuthorizationOptions {
  /** Verification key exported from the same Groth16 setup as the agent's proving key. */
  verificationKey: Record<string, unknown>
  /** Decimal Poseidon commitment enrolled for the one authorized agent. */
  commitment: string
}

export function secretToField (secret: string): string {
  if (!secret) throw new Error('ZK agent secret must not be empty')

  // Circom inputs are field elements, while deployment secrets are normally
  // arbitrary text. Hash the text first, then reduce it into BN254's scalar
  // field; the circuit proves knowledge of this derived value, not the text.
  // Use a randomly generated, high-entropy token: this is not password hashing
  // and a weak password could be guessed by testing candidate commitments.
  const digest = createHash('sha256').update(secret, 'utf8').digest('hex')
  return (BigInt(`0x${digest}`) % BN254_SCALAR_FIELD).toString()
}

async function proveAgent (options: AgentProofOptions): Promise<{ proof: Record<string, unknown>, publicSignals: string[] }> {
  // fullProve runs the WASM witness calculator with the private circuit input,
  // then creates a randomized Groth16 proof with the local proving key. Its
  // result contains the proof plus the circuit's public outputs; only those
  // outputs and the proof are returned to callers, never the witness.
  return await groth16.fullProve(
    { secret: secretToField(options.secret) },
    options.wasmPath,
    options.zkeyPath
  )
}

export async function deriveAgentCommitment (options: AgentProofOptions): Promise<string> {
  // Enrollment uses exactly the same witness transformation and circuit as
  // normal requests. fullProve is intentionally used here as well, so the
  // configured server commitment comes directly from the real circuit output.
  const { publicSignals } = await proveAgent(options)
  // This circuit has one public output: Poseidon's hash of the private field
  // value. Reject a different circuit/key configuration instead of silently
  // enrolling an unexpected output or signal ordering.
  if (publicSignals.length !== 1) throw new Error('Agent circuit must expose exactly one public signal')
  return publicSignals[0]
}

export async function createAgentProofHeaders (options: AgentProofOptions): Promise<Record<string, string>> {
  const result = await proveAgent(options)

  // BRC-121 continues to use its own x-bsv-* payment headers. These two
  // separate headers carry the Groth16 proof and its public inputs as JSON;
  // the private secret was only supplied to fullProve on this machine.
  // The proof is currently reusable: request-specific replay protection would
  // require a nonce to be included as a public circuit input and verified here.
  return {
    [ZK_PROOF_HEADER]: JSON.stringify(result.proof),
    [ZK_SIGNALS_HEADER]: JSON.stringify(result.publicSignals)
  }
}

export async function loadVerificationKey (path: string): Promise<Record<string, unknown>> {
  const value: unknown = JSON.parse(await readFile(path, 'utf8'))
  // Validate the top-level JSON shape before passing it to snarkjs. This is a
  // configuration sanity check, not a cryptographic validation of the key.
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Invalid Groth16 verification key at ${path}`)
  }
  return value as Record<string, unknown>
}

function parseProof (raw: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(raw)
    // A JSON array is also an object in JavaScript, but is not a Groth16 proof
    // object. Keep malformed input out of the cryptographic verifier.
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
    return parsed as Record<string, unknown>
  } catch {
    return undefined
  }
}

function parseSignals (raw: string): string[] | undefined {
  try {
    const parsed: unknown = JSON.parse(raw)
    // snarkjs expects public signals as decimal strings; numbers could lose
    // precision in JavaScript before verification.
    if (!Array.isArray(parsed) || !parsed.every(value => typeof value === 'string')) return undefined
    return parsed
  } catch {
    return undefined
  }
}

export function verifyAgentRequest (options: AgentAuthorizationOptions): RequestHandler {
  return async (req, res, next) => {
    // Both headers are mandatory. The request-size checks happen before JSON
    // parsing and curve operations; the HTTP server also has its own total
    // header-size limit for requests rejected before Express is reached.
    const rawProof = req.get(ZK_PROOF_HEADER)
    const rawSignals = req.get(ZK_SIGNALS_HEADER)
    if (!rawProof || !rawSignals || rawProof.length > MAX_HEADER_LENGTH || rawSignals.length > MAX_HEADER_LENGTH) {
      res.status(401).json({ error: 'valid agent proof required' })
      return
    }

    const proof = parseProof(rawProof)
    const publicSignals = parseSignals(rawSignals)
    // Pin the sole public output to the server's enrolled commitment before
    // doing Groth16 verification. A valid proof for somebody else's commitment
    // must not authorize this provider, and malformed signals fail cheaply.
    if (!proof || !publicSignals || publicSignals.length !== 1 || publicSignals[0] !== options.commitment) {
      res.status(401).json({ error: 'valid agent proof required' })
      return
    }

    try {
      // verify checks the pairing equation against the trusted verification
      // key and exactly these public signals. Only a true result reaches the
      // next Express middleware (the BRC-121 payment challenge/handler).
      if (!await groth16.verify(options.verificationKey, publicSignals, proof)) {
        res.status(401).json({ error: 'valid agent proof required' })
        return
      }
      next()
    } catch {
      // Treat malformed proofs and verifier failures as unauthorized. Do not
      // leak parsing or cryptographic details in an HTTP response.
      res.status(401).json({ error: 'valid agent proof required' })
    }
  }
}