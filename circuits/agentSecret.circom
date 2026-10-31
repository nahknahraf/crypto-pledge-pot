pragma circom 2.1.6;

include "circomlib/circuits/poseidon.circom";

template AgentSecret() {
    // This is the private witness supplied to snarkjs.fullProve. Since it is
    // not declared public in main's public-signal list, it is not sent to the
    // verifier as part of the proof request.
    signal input secret;

    // The circuit's only public output identifies the enrolled agent without
    // revealing the witness itself.
    signal output commitment;

    // Poseidon is a SNARK-friendly hash: its constraints are much cheaper to
    // verify in-circuit than a conventional SHA-256 hash. The input is already
    // mapped to a BN254 field element by secretToField in the TypeScript code.
    component hash = Poseidon(1);
    hash.inputs[0] <== secret;

    // Circom constrains this public output to equal Poseidon's digest. A proof
    // is accepted only if its prover knew an input satisfying this relation.
    commitment <== hash.out;
}

// Export this template as the circuit's main component. Groth16 will expose
// commitment as its public signal and treat secret as a private witness.
component main = AgentSecret();