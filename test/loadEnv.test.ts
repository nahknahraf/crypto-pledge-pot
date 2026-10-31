import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadSecrets, parseEnv } from '../core/loadEnv'

describe('secrets file loader', () => {
  const keys = ['CPP_T_A', 'CPP_T_B', 'CPP_T_C', 'CPP_T_EMPTY']
  afterEach(() => { for (const k of keys) delete process.env[k] })

  it('parses KEY=value, quotes, comments and export', () => {
    expect(parseEnv('# c\nA=1\nexport B="x y"\nC=\'q#r\'\nD=v # note\nbad line\nE=')).toEqual({ A: '1', B: 'x y', C: 'q#r', D: 'v', E: '' })
  })

  it('fills only unset variables, skips empty values, and never overrides the shell', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpp-secrets-'))
    const file = path.join(dir, 'secrets.env')
    fs.writeFileSync(file, 'CPP_T_A=from-file\nCPP_T_B=from-file\nCPP_T_EMPTY=\n', { mode: 0o600 })
    process.env.CPP_T_B = 'from-shell'
    expect(loadSecrets(file)).toBe(file)
    expect(process.env.CPP_T_A).toBe('from-file')
    expect(process.env.CPP_T_B).toBe('from-shell')
    expect(process.env.CPP_T_EMPTY).toBeUndefined()
    fs.rmSync(dir, { recursive: true })
  })

  it('a missing file or "none" loads nothing', () => {
    expect(loadSecrets('/nonexistent/secrets.env')).toBeUndefined()
    expect(loadSecrets('none')).toBeUndefined()
  })
})
