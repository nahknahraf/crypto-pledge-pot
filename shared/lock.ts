/**
 * One process per agent state. Two copies of an agent on the same state files
 * would both pay, pledge or lock sats for the same step. Each agent's main
 * takes this lock at start-up; a lock left by a process that died is taken over.
 */
import fs from 'node:fs'
import path from 'node:path'

const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' }
}

/** Take `file` for this process, or throw if a live process holds it. Returns a release function. */
export function acquireLock (file: string): () => void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, String(process.pid), { flag: 'wx' })
      let released = false
      const release = (): void => { if (!released) { released = true; try { if (fs.readFileSync(file, 'utf8') === String(process.pid)) fs.unlinkSync(file) } catch {} } }
      process.once('exit', release)
      return release
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      const holder = Number(fs.readFileSync(file, 'utf8'))
      if (Number.isInteger(holder) && holder > 0 && alive(holder)) throw new Error(`another process (pid ${holder}) is already running with ${file}; stop it first`)
      fs.unlinkSync(file) // stale: its process is gone
    }
  }
  throw new Error(`could not take ${file}`)
}
