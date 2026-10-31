/** npm run preflight: run the video's "Before recording" checks (scripts/preflightChecks.ts). Exit 1 if any fails. */
import '../core/loadEnv'
import net from 'node:net'
import { runPreflight } from './preflightChecks'

const portOpen = async (port: number): Promise<boolean> => await new Promise(resolve => {
  const s = net.connect({ host: '127.0.0.1', port }, () => { s.destroy(); resolve(true) })
  s.on('error', () => resolve(false)); s.setTimeout(1000, () => { s.destroy(); resolve(false) })
})
const checks = await runPreflight({ fetch, env: process.env, portOpen })
const mark = { ok: '✓', warn: '!', fail: '✗' } as const
for (const c of checks) console.log(`${mark[c.status]} ${c.name}: ${c.detail}`)
const failed = checks.filter(c => c.status === 'fail').length
console.log(failed === 0 ? '\nReady to record.' : `\n${failed} check(s) failed: fix them before recording.`)
process.exit(failed === 0 ? 0 : 1)
