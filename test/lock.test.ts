import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { acquireLock } from '../shared/lock'

const tmp = (): string => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lock-')), 'agent.lock')

describe('one process per agent state (F12)', () => {
  it('a second start on the same state is refused while the first runs; after release it works', () => {
    const file = tmp()
    const release = acquireLock(file)
    expect(() => acquireLock(file)).toThrow(/already running/)
    release()
    expect(fs.existsSync(file)).toBe(false)
    acquireLock(file)()
  })
  it('a lock left by a process that died is taken over', () => {
    const file = tmp()
    fs.writeFileSync(file, '2147483646') // no such process
    const release = acquireLock(file)
    expect(fs.readFileSync(file, 'utf8')).toBe(String(process.pid))
    release()
  })
})
