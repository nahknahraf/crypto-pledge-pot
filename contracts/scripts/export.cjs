// Copy the parts of the compiled artifact the app needs into ../core, so the
// app (browser + server) never depends on the sCrypt toolchain at runtime.
const fs = require('fs')
const path = require('path')
const a = require('../artifacts/bitfundPledge.json')
const slim = {
  contract: a.contract,
  version: a.version,
  compilerVersion: a.compilerVersion,
  md5: a.md5,
  abi: a.abi,
  stateProps: a.stateProps,
  hex: a.hex
}
const out = path.join(__dirname, '..', '..', 'core', 'bitfundPledge.artifact.json')
fs.writeFileSync(out, JSON.stringify(slim, null, 2) + '\n')
console.log('wrote', out, `(${a.hex.length / 2 | 0} byte template)`)
