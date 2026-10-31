/**
 * Start a local EVM chain (Foundry's Anvil) for tests and the bridge demo.
 *
 * The binary comes from the @foundry-rs/anvil npm package (a dev dependency,
 * one prebuilt binary per platform). Set ANVIL_BIN to use another one.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import net from 'node:net'
import path from 'node:path'
import { mnemonicToAccount } from 'viem/accounts'
import type { Account } from 'viem'

/** Anvil's well-known development mnemonic: these keys are public. Local chains only. */
export const ANVIL_MNEMONIC = 'test test test test test test test test test test test junk'
export const anvilAccount = (index: number): Account => mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: index })

export function anvilBinary (): string | undefined {
  if (process.env.ANVIL_BIN !== undefined && process.env.ANVIL_BIN !== '') return process.env.ANVIL_BIN
  const arch = process.arch === 'x64' ? 'amd64' : process.arch
  try {
    const pkg = createRequire(import.meta.url).resolve(`@foundry-rs/anvil-${process.platform}-${arch}/package.json`)
    return path.join(path.dirname(pkg), 'bin', process.platform === 'win32' ? 'anvil.exe' : 'anvil')
  } catch { return undefined }
}

export interface Anvil { rpcUrl: string, stop: () => Promise<void> }

/** A free TCP port on this machine. */
export async function freePort (): Promise<number> {
  return await new Promise((resolve, reject) => {
    const s = net.createServer().once('error', reject).listen(0, '127.0.0.1', () => {
      const { port } = s.address() as net.AddressInfo
      s.close(() => resolve(port))
    })
  })
}

/** `timestamp`: the chain's start time (unix seconds), e.g. in the past so BSV timelocks line up with the mock chain. */
export async function startAnvil (port?: number, opts: { timestamp?: number, forkUrl?: string } = {}): Promise<Anvil> {
  port ??= await freePort()
  const bin = anvilBinary()
  if (bin === undefined) throw new Error('anvil not found: npm install (dev dependency @foundry-rs/anvil) or set ANVIL_BIN')
  const proc: ChildProcess = spawn(bin, ['--port', String(port), '--silent', ...(opts.forkUrl === undefined ? ['--chain-id', '31337'] : []), /* a fork keeps its real chain id: EIP-712 domains depend on it */ ...(opts.timestamp !== undefined ? ['--timestamp', String(opts.timestamp)] : []), ...(opts.forkUrl !== undefined ? ['--fork-url', opts.forkUrl] : [])], { stdio: 'ignore' })
  const rpcUrl = `http://127.0.0.1:${port}`
  const exited = new Promise<void>(resolve => proc.once('exit', () => resolve()))
  for (let i = 0; i < (opts.forkUrl !== undefined ? 600 : 100); i++) { // a fork needs longer to start
    try {
      const r = await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }) })
      if (r.ok) return { rpcUrl, stop: async () => { proc.kill(); await exited } }
    } catch {}
    if (proc.exitCode !== null) throw new Error(`anvil exited with code ${proc.exitCode} (is port ${port} free?)`)
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  proc.kill()
  throw new Error('anvil did not start')
}

/** Give `address` some ETH for gas (Anvil only). */
export async function anvilSetBalance (rpcUrl: string, address: string, wei: bigint): Promise<void> {
  await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'anvil_setBalance', params: [address, `0x${wei.toString(16)}`] }) })
}

/** Mine `blocks` empty blocks (Anvil only). */
export async function anvilMine (rpcUrl: string, blocks: number): Promise<void> {
  await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'anvil_mine', params: [`0x${blocks.toString(16)}`] }) })
}

/** Move the local chain's clock forward (Anvil only). */
export async function anvilIncreaseTime (rpcUrl: string, seconds: number): Promise<void> {
  for (const [method, params] of [['evm_increaseTime', [seconds]], ['evm_mine', []]] as const) {
    await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
  }
}
