/**
 * Offline demo only: a BRC-100 wallet substrate that forwards every call to
 * this browser's simulated wallet on the demo server (server/demoWallet.ts).
 * Wrapped in WalletClient like any other substrate, so arguments and results
 * are validated the same way as with BSV Desktop.
 */
import { stringifyBRC100, type WalletInterface } from '@bsv/sdk'

const CALLS = [
  'createAction', 'signAction', 'abortAction', 'listActions', 'internalizeAction', 'listOutputs', 'relinquishOutput',
  'getPublicKey', 'revealCounterpartyKeyLinkage', 'revealSpecificKeyLinkage', 'encrypt', 'decrypt', 'createHmac', 'verifyHmac',
  'createSignature', 'verifySignature', 'acquireCertificate', 'listCertificates', 'proveCertificate', 'relinquishCertificate',
  'discoverByIdentityKey', 'discoverByAttributes', 'isAuthenticated', 'waitForAuthentication', 'getHeight', 'getHeaderForHeight',
  'getNetwork', 'getVersion'
] as const

const SESSION_KEY = 'cryptopledgepot-demo-wallet'

/** This browser's demo wallet id: kept across reloads when storage works, so the same wallet comes back. */
function sessionId (): string {
  const fresh = (): string => Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('')
  try {
    const saved = localStorage.getItem(SESSION_KEY)
    if (saved !== null && /^[0-9a-f]{32}$/.test(saved)) return saved
    const id = fresh()
    localStorage.setItem(SESSION_KEY, id)
    return id
  } catch {
    return fresh()
  }
}

export function demoWalletSubstrate (baseUrl: string): WalletInterface {
  const url = `${baseUrl}/api/demo-wallet/${sessionId()}`
  const call = (name: string) => async (args: unknown): Promise<unknown> => {
    const res = await fetch(`${url}/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: stringifyBRC100(args ?? {}) })
    const body = await res.json()
    if (!res.ok) throw new Error(body?.error ?? `demo wallet ${name} failed (HTTP ${res.status})`)
    return body
  }
  return Object.fromEntries(CALLS.map(name => [name, call(name)])) as unknown as WalletInterface
}
