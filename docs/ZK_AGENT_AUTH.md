# ZK agent authorization

The optional agent authorization proves knowledge of a secret without sending
the secret in an HTTP request. The witness is `SHA-256(secret) mod Fr`; the
circuit publishes only its Poseidon commitment. Use a high-entropy random token,
not a human password: public commitments can be tested against guesses.

## Build the circuit

Install the Circom compiler (2.1.6 or newer) and project dependencies, then run:

```powershell
circom circuits/agentSecret.circom --r1cs --wasm --sym -l node_modules
```

Create a Groth16 proving key and verification key using a properly conducted
trusted setup. For local development, the `snarkjs` CLI can run the standard
Powers of Tau and Groth16 commands; production keys must come from a reviewed,
multi-party ceremony, not a single-party setup. Export the verification key
with `snarkjs zkey export verificationkey` and keep the `.wasm` and `.zkey`
files out of source control.

Generate the public commitment for enrollment without printing the secret or
proof:

```powershell
$env:AGENT_ZK_SECRET = "<high-entropy token>"
$env:AGENT_ZK_WASM = "circuits/agentSecret_js/agentSecret.wasm"
$env:AGENT_ZK_ZKEY = "circuits/agentSecret_final.zkey"
npx tsx scripts/deriveAgentCommitment.ts
```

Store the resulting decimal signal as `ZK_AGENT_COMMITMENT` at the provider.

## Configure the provider

Set `ZK_AGENT_AUTH=1`, `ZK_AGENT_COMMITMENT` to the circuit's enrolled public
signal, and `ZK_VERIFICATION_KEY` to the exported verification-key JSON path
before starting `npm run data-provider`. The middleware checks the proof before
the BRC-121 payment middleware, so an unauthorized request receives HTTP 401
without reaching payment processing.

## Configure the agent

When ZK authorization is enabled, set `AGENT_ZK_SECRET` to the enrolled secret,
`AGENT_ZK_WASM` to the generated witness calculator, and `AGENT_ZK_ZKEY` to the
Groth16 proving key. The agent generates a fresh proof locally for each call
and sends it in `x-zk-proof` and `x-zk-signals` on both the initial 402 request
and the payment retry.

Proofs are not request-bound and can be replayed while the commitment remains
authorized. Use HTTPS and add challenge/nonces bound into the circuit if the
proof itself must be non-replayable.