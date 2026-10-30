/**
 * Wallet provider: connects to the user's BRC-100 wallet (BSV Desktop or any
 * compatible wallet) through @bsv/sdk's WalletClient and exposes a CryptoPledgePot
 * client bound to it. Keys stay in the wallet; every action is approved there.
 */
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import { WalletClient } from '@bsv/sdk'
import { CryptoPledgePot } from '../../client/cryptoPledgePot'
import { CryptoPledgePotApi } from '../../client/cryptoPledgePotApi'

export const api = new CryptoPledgePotApi(window.location.origin)

interface WalletState {
  cryptopledgepot?: CryptoPledgePot
  identityKey?: string
  network?: string
  connecting: boolean
  error?: string
  connect: () => Promise<CryptoPledgePot | undefined>
}

const Ctx = createContext<WalletState | undefined>(undefined)

export function WalletProvider ({ children }: { children: ReactNode }) {
  const [cryptopledgepot, setCryptoPledgePot] = useState<CryptoPledgePot>()
  const [identityKey, setIdentityKey] = useState<string>()
  const [network, setNetwork] = useState<string>()
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState<string>()

  const connect = useCallback(async () => {
    if (cryptopledgepot !== undefined) return cryptopledgepot
    setConnecting(true)
    setError(undefined)
    try {
      const wallet = new WalletClient('auto')
      await wallet.waitForAuthentication({})
      const { network } = await wallet.getNetwork({})
      const { publicKey } = await wallet.getPublicKey({ identityKey: true })
      api.connect(wallet)
      const bf = new CryptoPledgePot(wallet, api)
      setCryptoPledgePot(bf)
      setIdentityKey(publicKey)
      setNetwork(network)
      return bf
    } catch (e) {
      setError(`Could not reach a BRC-100 wallet. Open and unlock BSV Desktop, then retry. (${(e as Error).message})`)
      return undefined
    } finally {
      setConnecting(false)
    }
  }, [cryptopledgepot])

  const value = useMemo(() => ({ cryptopledgepot, identityKey, network, connecting, error, connect }), [cryptopledgepot, identityKey, network, connecting, error, connect])
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useWallet (): WalletState {
  const v = useContext(Ctx)
  if (v === undefined) throw new Error('useWallet outside WalletProvider')
  return v
}
