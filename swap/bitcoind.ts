/**
 * A throwaway Bitcoin Core node in regtest, for tests and the demo (like swap/anvil.ts for EVM).
 * Fresh data directory and random RPC credentials per run; deleted on stop().
 * The binary: BITCOIND_BIN, else ~/opt/bitcoin-<version>/bin/bitcoind (newest), else `bitcoind` on PATH.
 */
import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { freePort } from './anvil'
import { BitcoindRpc } from './btcChain'

export function bitcoindBinary (): string | undefined {
  if (process.env.BITCOIND_BIN !== undefined) return fs.existsSync(process.env.BITCOIND_BIN) ? process.env.BITCOIND_BIN : undefined
  const opt = path.join(os.homedir(), 'opt')
  const local = fs.existsSync(opt)
    ? fs.readdirSync(opt).filter(d => /^bitcoin-\d+\.\d+/.test(d)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).map(d => path.join(opt, d, 'bin', 'bitcoind')).filter(f => fs.existsSync(f)).pop()
    : undefined
  if (local !== undefined) return local
  const which = spawnSync('which', ['bitcoind'], { encoding: 'utf8' })
  return which.status === 0 ? which.stdout.trim() : undefined
}

export interface Regtest {
  rpc: BitcoindRpc
  /** A wallet in the node with 50+ mature BTC (the donor's Bitcoin wallet in tests). */
  wallet: string
  /** Mine n blocks (to the wallet). With setMockTime, blocks carry that time. */
  mine: (n?: number) => Promise<void>
  /** Move the node's clock (and, after ~11 blocks, the median time past that timelocks use). */
  setMockTime: (unix: number) => Promise<void>
  /** ZMQ endpoints, when started with { zmq: true } (LND needs them). */
  zmq?: { rawBlock: string, rawTx: string }
  stop: () => Promise<void>
}

export async function startRegtest (opts: { zmq?: boolean } = {}): Promise<Regtest> {
  const bin = bitcoindBinary()
  if (bin === undefined) throw new Error('bitcoind not found: set BITCOIND_BIN')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpp-regtest-'))
  const rpcPort = await freePort() // no P2P port: -listen=0
  const user = 'cpp'; const password = randomBytes(16).toString('hex')
  const zmq = opts.zmq === true ? { rawBlock: `tcp://127.0.0.1:${await freePort()}`, rawTx: `tcp://127.0.0.1:${await freePort()}` } : undefined
  const proc = spawn(bin, [
    '-regtest', `-datadir=${dir}`, '-server', '-txindex', '-listen=0', `-rpcport=${rpcPort}`, '-rpcbind=127.0.0.1', '-rpcallowip=127.0.0.1',
    `-rpcuser=${user}`, `-rpcpassword=${password}`, '-fallbackfee=0.0002', '-printtoconsole=0', '-disablewallet=0',
    ...(zmq === undefined ? [] : [`-zmqpubrawblock=${zmq.rawBlock}`, `-zmqpubrawtx=${zmq.rawTx}`])
  ], { stdio: 'ignore' })
  const rpc = new BitcoindRpc(`http://127.0.0.1:${rpcPort}`, user, password)
  for (let i = 0; ; i++) {
    try { await rpc.call('getblockchaininfo'); break } catch (e) {
      if (i > 150 || proc.exitCode !== null) { proc.kill(); throw new Error(`bitcoind did not start: ${(e as Error).message}`) }
      await new Promise(r => setTimeout(r, 200))
    }
  }
  const wallet = 'donor'
  await rpc.call('createwallet', [wallet])
  const address = await rpc.call<string>('getnewaddress', [], wallet)
  const mine = async (n = 1): Promise<void> => { await rpc.call('generatetoaddress', [n, address]) }
  await mine(101) // coinbase outputs mature after 100 blocks
  return {
    rpc,
    wallet,
    mine,
    zmq,
    setMockTime: async (unix) => { await rpc.call('setmocktime', [unix]) },
    stop: async () => {
      await rpc.call('stop').catch(() => {})
      await new Promise<void>(resolve => { if (proc.exitCode !== null) resolve(); else proc.once('exit', () => resolve()) })
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }
}
