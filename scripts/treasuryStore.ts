/** The treasury's small state files (data/treasury/), so restarts never lose a deposit or pay an agent twice. */
import fs from 'node:fs'
import path from 'node:path'
import type { ReceiveAddress } from '../client/receive'
import type { FundResult } from '../shared/treasury'

export function fundStore (dir: string) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const file = (n: string): string => path.join(dir, n)
  const read = <T>(n: string, d: T): T => { try { return JSON.parse(fs.readFileSync(file(n), 'utf8')) as T } catch { return d } }
  const write = (n: string, v: unknown): void => { fs.writeFileSync(`${file(n)}.tmp`, JSON.stringify(v, null, 2)); fs.renameSync(`${file(n)}.tmp`, file(n)) }
  return {
    deposit: (): ReceiveAddress | undefined => read<ReceiveAddress | undefined>('deposit.json', undefined),
    saveDeposit: (a: ReceiveAddress): void => { write('deposit.json', a) },
    claimed: (): string[] => read<string[]>('claimed.json', []),
    addClaimed: (txid: string): void => { write('claimed.json', [...new Set([...read<string[]>('claimed.json', []), txid])]) },
    /** Agents already paid, by name: a re-run pays only the others. */
    funded: (): FundResult[] => read<FundResult[]>('funded.json', []),
    addFunded: (r: FundResult[]): void => { write('funded.json', [...read<FundResult[]>('funded.json', []), ...r.filter(x => x.ok)]) }
  }
}
