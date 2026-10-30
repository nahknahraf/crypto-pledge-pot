// Generate reference locking scripts with scrypt-ts itself. The main test suite
// (test/pledge.script.test.ts) checks core/pledge.ts reproduces them byte for byte.
const fs = require('fs')
const path = require('path')
const { CryptoPledgePotEscrow } = require('../dist/cryptoPledgePotEscrow')
const { PubKey, toByteString, bsv } = require('scrypt-ts')
CryptoPledgePotEscrow.loadArtifact(require('../artifacts/cryptoPledgePotEscrow.json'))

const key = (n) => new bsv.PrivateKey(new bsv.crypto.BN(n)).toPublicKey().toHex()
const cases = [
  { campaignId: '11'.repeat(32), creator: key(1), arbiter: key(2), donor: key(3), pledged: 5000, cumulativeBps: [2500, 10000, 10000, 10000], refundAfter: 1700000000 },
  { campaignId: 'ab'.repeat(32), creator: key(7), arbiter: key(8), donor: key(9), pledged: 1, cumulativeBps: [10000, 10000, 10000, 10000], refundAfter: 1 },
  { campaignId: '0f'.repeat(32), creator: key(10), arbiter: key(11), donor: key(12), pledged: 2100000000000000, cumulativeBps: [1600, 3300, 6600, 10000], refundAfter: 4294967295 }
]
const out = cases.map(c => {
  const inst = new CryptoPledgePotEscrow(toByteString(c.campaignId), PubKey(c.creator), PubKey(c.arbiter), PubKey(c.donor),
    BigInt(c.pledged), c.cumulativeBps.map(BigInt), BigInt(c.refundAfter))
  return { terms: c, script: inst.lockingScript.toHex() }
})
const file = path.join(__dirname, '..', '..', 'test', 'fixtures', 'pledge-scripts.json')
fs.mkdirSync(path.dirname(file), { recursive: true })
fs.writeFileSync(file, JSON.stringify(out, null, 1) + '\n')
console.log('wrote', file)
