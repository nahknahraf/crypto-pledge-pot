/**
 * The wallet gate: whether, and how, the web app may talk to the user's wallet.
 * Plain functions with no React and no DOM, so the rules can be read and tested
 * on their own (test/walletGate.test.ts). wallet.tsx only wires them into state.
 *
 *  1. Ask the server which network it indexes. Unreachable: no wallet actions.
 *  2. 'mock' (the offline demo): the wallet is NEVER constructed or contacted.
 *  3. Otherwise connect, and the wallet's network must match the server's.
 */
import type { WalletInterface } from '@bsv/sdk'

export type ServerNetwork = 'main' | 'test' | 'mock'
export const WALLET_NETWORK: Record<'main' | 'test', string> = { main: 'mainnet', test: 'testnet' }

/** The subset of a BRC-100 wallet the gate needs. */
export type GateWallet = Pick<WalletInterface, 'waitForAuthentication' | 'getNetwork' | 'getPublicKey'>

export type GateResult<W> =
  | { ok: true, wallet: W, server: 'main' | 'test', network: string, identityKey: string }
  | { ok: false, server?: ServerNetwork, error: string }

export async function openWallet<W extends GateWallet> (
  health: () => Promise<{ network?: ServerNetwork }>,
  makeWallet: () => W,
  known?: ServerNetwork
): Promise<GateResult<W>> {
  let server = known
  if (server === undefined) {
    try { server = (await health()).network ?? 'main' } catch {
      return { ok: false, error: 'The CryptoPledgePot server is unreachable, so no wallet actions are possible right now.' }
    }
  }
  if (server === 'mock') {
    return { ok: false, server, error: 'This is the offline demo: campaigns are simulated, so wallet actions are disabled and your wallet is never contacted.' }
  }
  try {
    const wallet = makeWallet()
    await wallet.waitForAuthentication({})
    const { network } = await wallet.getNetwork({})
    if (network !== WALLET_NETWORK[server]) {
      return { ok: false, server, error: `Your wallet is on ${network} but this CryptoPledgePot server runs on ${WALLET_NETWORK[server]}. Switch networks in your wallet.` }
    }
    const { publicKey } = await wallet.getPublicKey({ identityKey: true })
    return { ok: true, wallet, server, network, identityKey: publicKey }
  } catch (e) {
    return { ok: false, server, error: `Could not reach a BRC-100 wallet. Open and unlock BSV Desktop, then retry. (${(e as Error).message})` }
  }
}

/** The question asked before anything that moves money. */
export const spendPrompt = (what: string): string => `${what}\n\nThis is a real BSV transaction from your wallet. Continue?`
