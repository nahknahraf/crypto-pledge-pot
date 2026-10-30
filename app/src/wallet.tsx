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

export const api = new CryptoPledgePotApi(window.location.origin)

export type ServerNetwork = 'main' | 'test' | 'mock'
const WALLET_NETWORK: Record<'main' | 'test', string> = { main: 'mainnet', test: 'testnet' }

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
export const confirmSpend = (what: string): boolean =>
  window.confirm(`${what}\n\nThis is a real BSV transaction from your wallet. Continue?`)

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
    let server = serverNetwork
    if (server === undefined) {
      try { server = (await api.health()).network ?? 'main'; setServerNetwork(server) } catch {
        setError('The CryptoPledgePot server is unreachable, so no wallet actions are possible right now.')
        return undefined
      }
    }
    if (server === 'mock') {
      setError('This is the offline demo: campaigns are simulated, so wallet actions are disabled and your wallet is never contacted.')
      return undefined
    }
    setConnecting(true)
    try {
      const wallet = new WalletClient('auto')
      await wallet.waitForAuthentication({})
      const { network } = await wallet.getNetwork({})
      if (network !== WALLET_NETWORK[server]) {
        setError(`Your wallet is on ${network} but this CryptoPledgePot server runs on ${WALLET_NETWORK[server]}. Switch networks in your wallet.`)
        return undefined
      }
      const { publicKey } = await wallet.getPublicKey({ identityKey: true })
      api.connect(wallet)
      const client = new CryptoPledgePot(wallet, api)
      setCryptoPledgePot(client)
      setIdentityKey(publicKey)
      setNetwork(network)
      return client
    } catch (e) {
      setError(`Could not reach a BRC-100 wallet. Open and unlock BSV Desktop, then retry. (${(e as Error).message})`)
      return undefined
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
