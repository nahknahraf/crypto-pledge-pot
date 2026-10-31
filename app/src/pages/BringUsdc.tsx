/**
 * "Bring USDC": swap USDC from the donor's own EVM wallet into sats in their own
 * BSV wallet, then back a campaign. Atomic: either both sides settle or both
 * refund. The flow is liquidity-agent/browserSwap.ts (tested); this page only shows it.
 *
 * Configured at build time (VITE_LP_URL, VITE_EVM_RPC_URL, VITE_EVM_HTLC,
 * VITE_EVM_TOKEN, VITE_EVM_CHAIN=base-sepolia|base|anvil). Without them the page
 * says so; `npm run demo:bridge` shows the same flow in a terminal.
 */
import { useState } from 'react'
import { anvil, base, baseSepolia } from 'viem/chains'
import type { Address } from 'viem'
import { ArcadeChainTracker, ARCADE_MAINNET, ARCADE_TESTNET } from '../../../client/arcadeChainTracker'
import { swapUsdcToSats } from '../../../liquidity-agent/browserSwap'
import type { Eip1193 } from '../../../liquidity-agent/browserEvm'
import { USDC } from '../../../liquidity-agent/usdcChain'
import { Notice } from '../components/ui'
import { confirmSpend, useWallet } from '../wallet'

const env = import.meta.env
const config = env.VITE_LP_URL !== undefined && env.VITE_EVM_RPC_URL !== undefined && env.VITE_EVM_HTLC !== undefined && env.VITE_EVM_TOKEN !== undefined
  ? {
      lpUrl: env.VITE_LP_URL as string,
      evm: {
        name: 'USDC',
        rpcUrl: env.VITE_EVM_RPC_URL as string,
        chain: env.VITE_EVM_CHAIN === 'base' ? base : env.VITE_EVM_CHAIN === 'anvil' ? anvil : baseSepolia,
        htlc: env.VITE_EVM_HTLC as Address,
        token: env.VITE_EVM_TOKEN as Address,
        permit: true
      }
    }
  : undefined

export function BringUsdc () {
  const { cryptopledgepot, connect, serverNetwork, error } = useWallet()
  const [amount, setAmount] = useState('10')
  const [lines, setLines] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<boolean>()
  const ethereum = (window as unknown as { ethereum?: Eip1193 }).ethereum

  if (config === undefined) {
    return <div className="card"><h2>Bring USDC</h2><p>This server has no liquidity agent configured. The same flow runs in a terminal with <code>npm run demo:bridge</code>.</p></div>
  }
  const start = async (): Promise<void> => {
    const usdc = Math.round(Number(amount) * USDC)
    if (!Number.isSafeInteger(usdc) || usdc <= 0) return
    if (!confirmSpend(`Lock ${amount} USDC from your EVM wallet in an atomic swap for sats in your BSV wallet? If the swap does not complete, your USDC comes back after the timeout.`)) return
    setBusy(true); setLines([]); setDone(undefined)
    try {
      const client = cryptopledgepot ?? await connect()
      if (client === undefined) return
      const tracker = new ArcadeChainTracker(serverNetwork === 'test' ? ARCADE_TESTNET : ARCADE_MAINNET)
      const r = await swapUsdcToSats(ethereum!, client.wallet, tracker, config, usdc, l => setLines(x => [...x, l]))
      setDone(r.state === 'claimed')
    } catch (e) {
      setLines(x => [...x, `stopped: ${(e as Error).message}`]); setDone(false)
    } finally { setBusy(false) }
  }
  return (
    <div className="card">
      <h2>Bring USDC</h2>
      <p className="small muted">Swap USDC from your own EVM wallet into sats in your own BSV wallet, with no exchange and no custodian: one secret unlocks both sides, or both sides get their money back.</p>
      {ethereum === undefined && <Notice kind="err">No EVM wallet found in this browser (e.g. MetaMask).</Notice>}
      {serverNetwork === 'mock' && <Notice kind="err">This is the offline demo; swaps need a real network.</Notice>}
      {error !== undefined && <Notice kind="err">{error}</Notice>}
      <div className="row">
        <input value={amount} onChange={e => setAmount(e.target.value)} inputMode="decimal" style={{ width: '8rem' }} /> <span>USDC</span>
        <button className="primary" disabled={busy || ethereum === undefined || serverNetwork === 'mock'} onClick={() => { void start() }}>{busy ? 'Swapping…' : 'Swap into sats'}</button>
      </div>
      <ol className="small">{lines.map((l, i) => <li key={i}>{l}</li>)}</ol>
      {done === true && <Notice kind="ok">The sats are in your BSV wallet. <a href="#/">Back a campaign →</a></Notice>}
    </div>
  )
}
