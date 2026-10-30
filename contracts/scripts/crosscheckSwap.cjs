// Reference AtomicSwap locking scripts from scrypt-ts itself; test/swap.script.test.ts
// checks core/swap.ts reproduces them byte for byte.
const fs = require('fs')
const path = require('path')
const { AtomicSwap } = require('../dist/atomicSwap')
const { PubKey, Sha256, bsv } = require('scrypt-ts')
AtomicSwap.loadArtifact(require('../artifacts/atomicSwap.json'))
const key = (n) => new bsv.PrivateKey(new bsv.crypto.BN(n)).toPublicKey().toHex()
const cases = [
  { hashlock: '11'.repeat(32), receiver: key(1), sender: key(2), refundAfter: 1700000000 },
  { hashlock: 'ab'.repeat(32), receiver: key(3), sender: key(4), refundAfter: 4294967295 },
  { hashlock: '0f'.repeat(32), receiver: key(5), sender: key(6), refundAfter: 500000000 }
]
const out = cases.map(t => ({ terms: t, script: new AtomicSwap(Sha256(t.hashlock), PubKey(t.receiver), PubKey(t.sender), BigInt(t.refundAfter)).lockingScript.toHex() }))
const file = path.join(__dirname, '..', '..', 'test', 'fixtures', 'swap-scripts.json')
fs.writeFileSync(file, JSON.stringify(out, null, 1) + '\n')
console.log('wrote', file)
