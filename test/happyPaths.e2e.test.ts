/**
 * Happy paths as stories: the narrated demos, run quietly with assertions.
 * The other happy paths are covered by their own suites; `npm run test:happy`
 * runs this file together with them (see docs/HAPPY_PATHS.md).
 */
import { describe, expect, it } from 'vitest'
import { runDonorDemo } from '../donor/donorDemo'
import { anvilBinary } from '../swap/anvil'
import { runBridgeDemo } from '../swap/bridgeDemo'
import { USDC } from '../swap/usdcChain'

const quiet = (): void => {}

describe('donor agent (demo:donor)', () => {
  it('co-pilot proposes with memos and pays nothing; the donor approves from their own wallet; autopilot pledges within budget and votes on evidence', async () => {
    const r = await runDonorDemo({ log: quiet })
    expect(r.copilot).toMatchObject({ evaluated: 5, proposed: 2, skipped: 3, manipulationScoredZero: true, agentPaidNothing: true })
    expect(r.copilot.approved).toMatch(/^[0-9a-f]{64}\.\d+$/)
    expect(r.autopilot.pledged).toBe(2)
    expect(r.autopilot.totalSats).toBeLessThanOrEqual(r.autopilot.budget)
    expect(r.autopilot.votedYes).toBe(true)
  }, 180_000)
})

describe.skipIf(anvilBinary() === undefined)('bridge on a real EVM chain (demo:bridge)', () => {
  it('USDC locked in the Solidity HTLC becomes sats in the donor\'s own wallet, the LP collects the USDC, and the sats back a campaign', async () => {
    const r = await runBridgeDemo({ log: quiet })
    expect(r).toMatchObject({ usdcLocked: 100 * USDC, satsReceived: 2_150_000, lpUsdc: 100 * USDC, pledged: 1_000_000, secretPublicOnEvm: true })
  }, 180_000)
})
