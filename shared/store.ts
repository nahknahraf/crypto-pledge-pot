/**
 * Small persistent state for any agent: in memory (tests) or a JSON file, replaced atomically on save.
 * Shared by every agent and the server; it belongs to none of them.
 */
import fs from 'node:fs'
import path from 'node:path'

export interface Store<T> { load: () => T, save: (value: T) => void }

export const memoryStore = <T>(initial: T): Store<T> => {
  let value = structuredClone(initial)
  return { load: () => structuredClone(value), save: v => { value = structuredClone(v) } }
}

export const fileStore = <T>(file: string, initial: T): Store<T> => ({
  load: () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T } catch { return structuredClone(initial) } },
  save: v => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(v, null, 2))
    fs.renameSync(tmp, file) // atomic replace: a crash never leaves half a ledger
  }
})
