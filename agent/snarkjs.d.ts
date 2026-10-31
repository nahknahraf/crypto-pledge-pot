// snarkjs 0.7.6 does not publish TypeScript declarations. Keep the local shim
// limited to the two APIs used here so the application's proof and verifier
// calls remain type-checked without claiming broader library coverage.
declare module 'snarkjs' {
  export namespace groth16 {
    function fullProve (
      input: Record<string, string>,
      wasmFile: string,
      zkeyFile: string
    ): Promise<{ proof: Record<string, unknown>, publicSignals: string[] }>

    function verify (
      verificationKey: Record<string, unknown>,
      publicSignals: string[],
      proof: Record<string, unknown>
    ): Promise<boolean>
  }
}