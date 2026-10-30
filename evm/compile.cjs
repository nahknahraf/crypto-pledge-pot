// Compile the EVM contracts with solc-js and write evm/artifacts.json (ABI + bytecode).
// The artifact is committed, so running the app or tests does not need solc.
//   node evm/compile.cjs
const fs = require('node:fs')
const path = require('node:path')
const solc = require('solc')

const dir = path.join(__dirname, 'contracts')
const sources = Object.fromEntries(fs.readdirSync(dir).filter(f => f.endsWith('.sol')).map(f => [f, { content: fs.readFileSync(path.join(dir, f), 'utf8') }]))
const input = { language: 'Solidity', sources, settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'cancun', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } } }
const out = JSON.parse(solc.compile(JSON.stringify(input)))
const errors = (out.errors ?? []).filter(e => e.severity === 'error')
for (const e of out.errors ?? []) console.error(e.formattedMessage)
if (errors.length > 0) process.exit(1)
const artifacts = { compiler: solc.version() }
for (const file of Object.keys(out.contracts)) {
  for (const [name, c] of Object.entries(out.contracts[file])) artifacts[name] = { abi: c.abi, bytecode: `0x${c.evm.bytecode.object}` }
}
fs.writeFileSync(path.join(__dirname, 'artifacts.json'), JSON.stringify(artifacts, null, 1) + '\n')
console.log(`compiled ${Object.keys(artifacts).filter(k => k !== 'compiler').join(', ')} with solc ${artifacts.compiler}`)
