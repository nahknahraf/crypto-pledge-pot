/**
 * Wallet provider: connects to the user's BRC-100 wallet (BSV Desktop or any
 * compatible wallet) through @bsv/sdk's WalletClient and exposes a CryptoPledgePot
 * client bound to it. Keys stay in the wallet; every action is approved there.
 *
 * Safety (after a real incident, see docs/DEVLOG.md): the app first asks the
 * server which network it indexes.
 *  - 'mock' (offline demo): the wallet is NEVER contacted. Demo campaigns are
 *    simulated, and a real payment into them could only come back via the
 *    timelocked refund.
 *  - otherwise the wallet's network must match the server's, or nothing happens.
 * Every spending action also asks for an explicit in-app confirmation first,
 * because a wallet with auto-approval turns one click into a payment.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { WalletClient } from '@bsv/sdk'
import { CryptoPledgePot } from '../../client/cryptoPledgePot'
import { CryptoPledgePotApi } from '../../client/cryptoPledgePotApi'
import { openWallet, spendPrompt, type ServerNetwork } from './walletGate'

export type { ServerNetwork } from './walletGate'
export const api = new CryptoPledgePotApi(window.location.origin)

interface WalletState {
  cryptopledgepot?: CryptoPledgePot
  identityKey?: string
  network?: string
  /** Network the server indexes; undefined until known. */
  serverNetwork?: ServerNetwork
  connecting: boolean
  error?: string
  connect: () => Promise<CryptoPledgePot | undefined>
}

const Ctx = createContext<WalletState | undefined>(undefined)

/** Ask before anything that moves money. Returns false if the user cancels. */
export const confirmSpend = (what: string): boolean => window.confirm(spendPrompt(what))

export function WalletProvider ({ children }: { children: ReactNode }) {
  const [cryptopledgepot, setCryptoPledgePot] = useState<CryptoPledgePot>()
  const [identityKey, setIdentityKey] = useState<string>()
  const [network, setNetwork] = useState<string>()
  const [serverNetwork, setServerNetwork] = useState<ServerNetwork>()
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState<string>()

  useEffect(() => { api.health().then(h => setServerNetwork(h.network ?? 'main'), () => setServerNetwork(undefined)) }, [])

  const connect = useCallback(async () => {
    if (cryptopledgepot !== undefined) return cryptopledgepot
    setError(undefined)
    setConnecting(true)
    try {
      // The rules (mock: never touch the wallet; networks must match) live in walletGate.ts.
      const r = await openWallet(async () => await api.health(), () => new WalletClient('auto'), serverNetwork)
      if (r.server !== undefined) setServerNetwork(r.server)
      if (!r.ok) { setError(r.error); return undefined }
      api.connect(r.wallet)
      const client = new CryptoPledgePot(r.wallet, api)
      setCryptoPledgePot(client)
      setIdentityKey(r.identityKey)
      setNetwork(r.network)
      return client
    } finally {
      setConnecting(false)
    }
  }, [cryptopledgepot, serverNetwork])

  const value = useMemo(() => ({ cryptopledgepot, identityKey, network, serverNetwork, connecting, error, connect }), [cryptopledgepot, identityKey, network, serverNetwork, connecting, error, connect])
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useWallet (): WalletState {
  const v = useContext(Ctx)
  if (v === undefined) throw new Error('useWallet outside WalletProvider')
  return v
}
