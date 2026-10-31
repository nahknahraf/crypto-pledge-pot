// Compile the EVM contracts with solc-js and write evm/artifacts.json (ABI + bytecode).
// The artifact is committed, so running the app or tests does not need solc.
//   npm run evm:compile        (installs evm/'s own dependencies first)
//
// require('./compile.cjs').standardInput() returns the exact Standard JSON input
// the artifact is built from, with every imported library source inlined. Source
// verification (npm run evm:verify, Sourcify) recompiles that input and compares
// it with the deployed bytecode.
//
// Sources: every .sol file under evm/contracts, including the API3 AirnodeHub
// libraries in evm/contracts/api3. Their imports resolve like the starter's
// Foundry remappings:
//   @openzeppelin/contracts/…  → evm/node_modules/@openzeppelin/contracts/…
//   solady/…                   → evm/node_modules/solady/src/…
const fs = require('node:fs')
const path = require('node:path')
const solc = require('solc')

const dir = path.join(__dirname, 'contracts')
const modules = path.join(__dirname, 'node_modules')
const REMAPPINGS = [
  ['@openzeppelin/contracts/', path.join(modules, '@openzeppelin', 'contracts')],
  ['solady/', path.join(modules, 'solady', 'src')]
]

const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)])
const own = walk(dir).filter(f => f.endsWith('.sol')).map(f => path.relative(dir, f).split(path.sep).join('/'))
const sources = Object.fromEntries(own.map(f => [f, { content: fs.readFileSync(path.join(dir, f), 'utf8') }]))

// Library sources solc asked for, by import path: standardInput() inlines them.
const imported = {}
function findImports (importPath) {
  for (const [prefix, target] of REMAPPINGS) {
    if (!importPath.startsWith(prefix)) continue
    const file = path.join(target, importPath.slice(prefix.length))
    if (fs.existsSync(file)) return { contents: (imported[importPath] = fs.readFileSync(file, 'utf8')) }
    return { error: `${importPath} not found: run npm install --prefix evm` }
  }
  const local = path.join(dir, importPath)
  return fs.existsSync(local) ? { contents: fs.readFileSync(local, 'utf8') } : { error: `${importPath} not found` }
}

const SETTINGS = { optimizer: { enabled: true, runs: 200 }, evmVersion: 'cancun' }
const compile = (outputSelection) => {
  const input = { language: 'Solidity', sources, settings: { ...SETTINGS, outputSelection } }
  return { input, out: JSON.parse(solc.compile(JSON.stringify(input), { import: findImports })) }
}

/** The Standard JSON input of the committed artifact, self-contained (libraries inlined under their import paths). */
function standardInput () {
  const { input, out } = compile({ '*': { '*': ['evm.bytecode.object'] } })
  const errors = (out.errors ?? []).filter(e => e.severity === 'error')
  if (errors.length > 0) throw new Error(errors.map(e => e.formattedMessage).join('\n'))
  const libs = Object.fromEntries(Object.entries(imported).map(([p, content]) => [p, { content }]))
  return { ...input, sources: { ...input.sources, ...libs }, settings: { ...SETTINGS, outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'metadata'] } } } }
}

module.exports = { standardInput, compilerVersion: () => solc.version() }
if (require.main !== module) return

const { out } = compile({ '*': { '*': ['abi', 'evm.bytecode.object'] } })
const errors = (out.errors ?? []).filter(e => e.severity === 'error')
// Warnings from the libraries (OpenZeppelin, Solady) are theirs; show only ours.
for (const e of out.errors ?? []) if (e.severity === 'error' || own.includes(e.sourceLocation?.file)) console.error(e.formattedMessage)
if (errors.length > 0) process.exit(1)
const artifacts = { compiler: solc.version() }
for (const file of own) {
  for (const [name, c] of Object.entries(out.contracts[file] ?? {})) {
    // The API3 libraries are inlined into the contracts that use them: nothing to deploy on their own.
    if (file.startsWith('api3/') || c.evm.bytecode.object === '') continue
    artifacts[name] = { abi: c.abi, bytecode: `0x${c.evm.bytecode.object}` }
  }
}
fs.writeFileSync(path.join(__dirname, 'artifacts.json'), JSON.stringify(artifacts, null, 1) + '\n')
console.log(`compiled ${Object.keys(artifacts).filter(k => k !== 'compiler').join(', ')} with solc ${artifacts.compiler}`)
