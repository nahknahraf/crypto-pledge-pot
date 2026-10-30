/**
 * Wallet provider: connects to the user's BRC-100 wallet (BSV Desktop or any
 * compatible wallet) through @bsv/sdk's WalletClient and exposes a BitFund
 * client bound to it. Keys stay in the wallet; every action is approved there.
 */
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import { WalletClient } from '@bsv/sdk'
import { BitFund } from '../../client/bitfund'
import { BitFundApi } from '../../client/bitfundApi'

export const api = new BitFundApi(window.location.origin)

interface WalletState {
  bitfund?: BitFund
  identityKey?: string
  network?: string
  connecting: boolean
  error?: string
  connect: () => Promise<BitFund | undefined>
}

const Ctx = createContext<WalletState | undefined>(undefined)

export function WalletProvider ({ children }: { children: ReactNode }) {
  const [bitfund, setBitfund] = useState<BitFund>()
  const [identityKey, setIdentityKey] = useState<string>()
  const [network, setNetwork] = useState<string>()
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState<string>()

  const connect = useCallback(async () => {
    if (bitfund !== undefined) return bitfund
    setConnecting(true)
    setError(undefined)
    try {
      const wallet = new WalletClient('auto')
      await wallet.waitForAuthentication({})
      const { network } = await wallet.getNetwork({})
      const { publicKey } = await wallet.getPublicKey({ identityKey: true })
      api.connect(wallet)
      const bf = new BitFund(wallet, api)
      setBitfund(bf)
      setIdentityKey(publicKey)
      setNetwork(network)
      return bf
    } catch (e) {
      setError(`Could not reach a BRC-100 wallet. Open and unlock BSV Desktop, then retry. (${(e as Error).message})`)
      return undefined
    } finally {
      setConnecting(false)
    }
  }, [bitfund])

  const value = useMemo(() => ({ bitfund, identityKey, network, connecting, error, connect }), [bitfund, identityKey, network, connecting, error, connect])
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useWallet (): WalletState {
  const v = useContext(Ctx)
  if (v === undefined) throw new Error('useWallet outside WalletProvider')
  return v
}
