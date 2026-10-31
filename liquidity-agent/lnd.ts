/**
 * LND over its REST API (https://lightning.engineering/api-docs/api/lnd/), and throwaway regtest
 * LND nodes for tests and the demo (like liquidity-agent/bitcoind.ts). Bytes in REST bodies are base64;
 * a macaroon authorizes every call; the node's self-signed TLS certificate is pinned.
 * The binary: LND_BIN, else ~/opt/lnd-linux-amd64-<version>/lnd (newest), else `lnd` on PATH.
 */
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import https from 'node:https'
import os from 'node:os'
import path from 'node:path'
import { freePort } from './anvil'
import type { Regtest } from './bitcoind'

export class LndRest {
  constructor (readonly url: string, private readonly macaroonHex: string, private readonly cert: Buffer) {}

  private request (method: string, p: string, body?: unknown): { req: ReturnType<typeof https.request>, res: Promise<import('node:http').IncomingMessage> } {
    const u = new URL(p, this.url)
    let req!: ReturnType<typeof https.request>
    const res = new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
      req = https.request(u, { method, ca: this.cert, headers: { 'Grpc-Metadata-macaroon': this.macaroonHex, 'content-type': 'application/json' } }, resolve)
      req.on('error', reject)
      if (body !== undefined) req.write(JSON.stringify(body))
      req.end()
    })
    return { req, res }
  }

  async call<T = any>(method: 'GET' | 'POST' | 'DELETE', p: string, body?: unknown): Promise<T> {
    const res = await this.request(method, p, body).res
    let text = ''
    for await (const chunk of res) text += String(chunk)
    const json = text === '' ? {} : JSON.parse(text)
    if ((res.statusCode ?? 500) >= 300) throw new Error(`lnd ${p}: ${json.message ?? text}`)
    return json as T
  }

  /** A server-streaming call (e.g. /v2/router/send): every JSON message goes to onMessage. Returns a stop function. */
  stream (p: string, body: unknown, onMessage: (m: any) => void, onError: (e: Error) => void = () => {}): () => void {
    const { req, res } = this.request('POST', p, body)
    res.then(async r => {
      let buf = ''
      for await (const chunk of r) {
        buf += String(chunk)
        let nl: number
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1)
          if (line === '') continue
          const m = JSON.parse(line)
          if (m.error !== undefined) onError(new Error(`lnd ${p}: ${m.error.message ?? JSON.stringify(m.error)}`)); else onMessage(m.result ?? m)
        }
      }
    }).catch(e => onError(e as Error))
    return () => { req.destroy() }
  }
}

export const b64 = (hex: string): string => Buffer.from(hex, 'hex').toString('base64')
export const unb64 = (s: string): string => Buffer.from(s, 'base64').toString('hex')

export function lndBinary (): string | undefined {
  if (process.env.LND_BIN !== undefined) return fs.existsSync(process.env.LND_BIN) ? process.env.LND_BIN : undefined
  const opt = path.join(os.homedir(), 'opt')
  const local = fs.existsSync(opt)
    ? fs.readdirSync(opt).filter(d => /^lnd-linux-amd64-v/.test(d)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).map(d => path.join(opt, d, 'lnd')).filter(f => fs.existsSync(f)).pop()
    : undefined
  if (local !== undefined) return local
  const which = spawnSync('which', ['lnd'], { encoding: 'utf8' })
  return which.status === 0 ? which.stdout.trim() : undefined
}

export interface LndNode { rest: LndRest, pubkey: string, p2p: string, stop: () => Promise<void> }

/** Start an LND node on a regtest bitcoind (started with { zmq: true }). Wallet created without a seed backup. */
export async function startLnd (btc: Regtest, alias: string): Promise<LndNode> {
  const bin = lndBinary()
  if (bin === undefined) throw new Error('lnd not found: set LND_BIN')
  if (btc.zmq === undefined) throw new Error('start the regtest node with { zmq: true }')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `cpp-lnd-${alias}-`))
  const [rpc, rest, p2p] = [await freePort(), await freePort(), await freePort()]
  const { user, password } = btc.rpc.credentials
  const proc = spawn(bin, [
    `--lnddir=${dir}`, `--alias=${alias}`, '--noseedbackup', '--bitcoin.regtest', '--bitcoin.node=bitcoind',
    `--bitcoind.rpchost=${new URL(btc.rpc.url).host}`, `--bitcoind.rpcuser=${user}`, `--bitcoind.rpcpass=${password}`,
    `--bitcoind.zmqpubrawblock=${btc.zmq.rawBlock}`, `--bitcoind.zmqpubrawtx=${btc.zmq.rawTx}`,
    `--rpclisten=127.0.0.1:${rpc}`, `--restlisten=127.0.0.1:${rest}`, `--listen=127.0.0.1:${p2p}`,
    '--debuglevel=warn', '--trickledelay=50', '--tlsextradomain=127.0.0.1'
  ], { stdio: 'ignore' })
  const macaroon = path.join(dir, 'data', 'chain', 'bitcoin', 'regtest', 'admin.macaroon')
  const cert = path.join(dir, 'tls.cert')
  let node: LndRest | undefined
  let pubkey = ''
  for (let i = 0; ; i++) {
    if (proc.exitCode !== null || i > 300) { proc.kill(); throw new Error(`lnd ${alias} did not start`) }
    await new Promise(r => setTimeout(r, 200))
    if (!fs.existsSync(macaroon) || !fs.existsSync(cert)) continue
    node ??= new LndRest(`https://127.0.0.1:${rest}`, fs.readFileSync(macaroon).toString('hex'), fs.readFileSync(cert))
    const info = await node.call<{ identity_pubkey: string, synced_to_chain: boolean }>('GET', '/v1/getinfo').catch(() => undefined)
    if (info?.synced_to_chain === true) { pubkey = info.identity_pubkey; break }
  }
  return {
    rest: node!,
    pubkey,
    p2p: `127.0.0.1:${p2p}`,
    stop: async () => {
      proc.kill('SIGTERM')
      await new Promise<void>(resolve => { if (proc.exitCode !== null) resolve(); else proc.once('exit', () => resolve()) })
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }
}

/** Fund `from` on chain and open a channel from it to `to`; returns once the channel is active. */
export async function openChannel (btc: Regtest, from: LndNode, to: LndNode, sats: number): Promise<void> {
  const { address } = await from.rest.call<{ address: string }>('GET', '/v1/newaddress?type=WITNESS_PUBKEY_HASH')
  await btc.rpc.call('sendtoaddress', [address, Number(((sats * 2) / 1e8).toFixed(8))], btc.wallet)
  await btc.mine(6)
  await waitFor(async () => Number((await from.rest.call('GET', '/v1/balance/blockchain')).confirmed_balance) >= sats * 2, 'on-chain funds')
  await from.rest.call('POST', '/v1/peers', { addr: { pubkey: to.pubkey, host: to.p2p }, perm: false }).catch(e => { if (!/already connected/.test((e as Error).message)) throw e })
  await from.rest.call('POST', '/v1/channels', { node_pubkey: b64(to.pubkey), local_funding_amount: String(sats), private: false })
  await waitFor(async () => (await from.rest.call('GET', '/v1/channels/pending')).pending_open_channels?.length > 0, 'pending channel')
  await btc.mine(6)
  await waitFor(async () => ((await from.rest.call('GET', '/v1/channels?active_only=true')).channels ?? []).some((c: any) => c.remote_pubkey === to.pubkey), 'active channel')
  // "Active" comes a moment before the link can carry payments: wait until a route exists.
  await waitFor(async () => (await from.rest.call('GET', `/v1/graph/routes/${to.pubkey}/1`)).routes?.length > 0, 'a usable route')
}

export async function waitFor (cond: () => Promise<boolean>, what: string, ms = 60_000): Promise<void> {
  const end = Date.now() + ms
  while (!(await cond().catch(() => false))) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await new Promise(r => setTimeout(r, 250))
  }
}
