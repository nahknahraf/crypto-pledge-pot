/** Root keys: an empty or malformed value must never become a usable key (found in the first Docker run). */
import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PrivateKey } from '@bsv/sdk'
import { loadOrCreateKey } from '../shared/wallet'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpp-keys-'))
const VAR = 'CPP_TEST_KEY'
afterEach(() => { delete process.env[VAR] })

describe('loadOrCreateKey', () => {
  it('treats an EMPTY variable (Docker Compose) like an unset one: generates a key file once, then reuses it', () => {
    process.env[VAR] = ''
    const file = path.join(dir, 'a.key')
    const k1 = loadOrCreateKey(VAR, file, () => {})
    expect(k1.toHex()).toMatch(/^[0-9a-f]{64}$/)
    expect(k1.toHex()).not.toMatch(/^0+$/)
    expect((fs.statSync(file).mode & 0o777).toString(8)).toBe('600')
    expect(loadOrCreateKey(VAR, file, () => {}).toHex()).toBe(k1.toHex())
  })

  it('uses a valid key from the environment', () => {
    const k = PrivateKey.fromRandom()
    process.env[VAR] = k.toHex()
    expect(loadOrCreateKey(VAR, path.join(dir, 'unused.key'), () => {}).toHex()).toBe(k.toHex())
  })

  it('refuses malformed and zero keys instead of using them', () => {
    for (const bad of ['xyz', '00', 'ab'.repeat(31), '0'.repeat(64)]) {
      process.env[VAR] = bad
      expect(() => loadOrCreateKey(VAR, path.join(dir, 'b.key'), () => {})).toThrow(/not a valid private key/)
    }
    delete process.env[VAR]
    const file = path.join(dir, 'corrupt.key')
    fs.writeFileSync(file, 'not hex')
    expect(() => loadOrCreateKey(VAR, file, () => {})).toThrow(/not a valid private key/)
  })
})
