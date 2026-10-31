import type { Request, Response } from 'express'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockGroth16 = vi.hoisted(() => ({
  fullProve: vi.fn(),
  verify: vi.fn()
}))

// Use a deterministic stand-in for the expensive cryptographic backend. These
// tests exercise the application boundary and header wiring; they do not prove
// that generated artifacts form a valid real-world Groth16 setup.
vi.mock('snarkjs', () => ({ groth16: mockGroth16 }))

import { createCappedPayer } from '../agent/pay402'
import { createAgentProofHeaders, deriveAgentCommitment, secretToField, verifyAgentRequest } from '../agent/zkAuth'

beforeEach(() => {
  vi.clearAllMocks()
  mockGroth16.fullProve.mockResolvedValue({ proof: { pi_a: ['1'] }, publicSignals: ['12345'] })
  mockGroth16.verify.mockResolvedValue(true)
})

describe('Groth16 agent authorization', () => {
  it('creates proof headers without putting the secret in either header', async () => {
    const secret = 'a-high-entropy-agent-token'
    const headers = await createAgentProofHeaders({ secret, wasmPath: 'circuit.wasm', zkeyPath: 'circuit.zkey' })

    expect(mockGroth16.fullProve).toHaveBeenCalledWith({ secret: secretToField(secret) }, 'circuit.wasm', 'circuit.zkey')
    expect(headers['x-zk-proof']).toBe(JSON.stringify({ pi_a: ['1'] }))
    expect(headers['x-zk-signals']).toBe(JSON.stringify(['12345']))
    expect(JSON.stringify(headers)).not.toContain(secret)
  })

  it('derives the enrolled commitment as a public signal', async () => {
    await expect(deriveAgentCommitment({ secret: 'private-token', wasmPath: 'circuit.wasm', zkeyPath: 'circuit.zkey' }))
      .resolves.toBe('12345')
  })

  it('verifies the configured commitment before calling next', async () => {
    // Express middleware must call next only after the public commitment has
    // matched configuration and snarkjs has accepted the proof.
    const next = vi.fn()
    const json = vi.fn()
    const response = { status: vi.fn(() => response), json } as unknown as Response
    const request = {
      get: (name: string) => name === 'x-zk-proof' ? '{"pi_a":["1"]}' : '["12345"]'
    } as unknown as Request

    await verifyAgentRequest({ verificationKey: { protocol: 'groth16' }, commitment: '12345' })(request, response, next)

    expect(mockGroth16.verify).toHaveBeenCalledWith({ protocol: 'groth16' }, ['12345'], { pi_a: ['1'] })
    expect(next).toHaveBeenCalledOnce()
    expect(json).not.toHaveBeenCalled()
  })

  it('rejects a mismatched public commitment without verifying', async () => {
    // Reject a proof for another public identity before spending time in the
    // pairing verifier or allowing downstream payment middleware to run.
    const next = vi.fn()
    const json = vi.fn()
    const response = { status: vi.fn(() => response), json } as unknown as Response
    const request = {
      get: (name: string) => name === 'x-zk-proof' ? '{"pi_a":["1"]}' : '["wrong"]'
    } as unknown as Request

    await verifyAgentRequest({ verificationKey: {}, commitment: '12345' })(request, response, next)

    expect(mockGroth16.verify).not.toHaveBeenCalled()
    expect(next).not.toHaveBeenCalled()
    expect(response.status).toHaveBeenCalledWith(401)
  })

  it('sends ZK headers with the first BRC-121 request', async () => {
    // The provider requires proof even to issue its 402 challenge, so auth
    // headers must accompany the initial request, not just the paid retry.
    let requestHeaders: Headers | undefined
    const fetchImpl: typeof fetch = async (_input, init) => {
      requestHeaders = new Headers(init?.headers)
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }
    const pay = createCappedPayer({
      wallet: {} as any,
      allowedHosts: ['provider.test'],
      maxPricePerCall: 100,
      fetchImpl,
      zkAuth: { secret: 'private-token', wasmPath: 'circuit.wasm', zkeyPath: 'circuit.zkey' }
    })

    await expect(pay('https://provider.test/data/munich')).resolves.toMatchObject({ paid: 0, body: { ok: true } })
    expect(requestHeaders?.get('x-zk-proof')).toBe(JSON.stringify({ pi_a: ['1'] }))
    expect(requestHeaders?.get('x-zk-signals')).toBe(JSON.stringify(['12345']))
  })
})