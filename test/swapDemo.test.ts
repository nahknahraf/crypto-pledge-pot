/** The swap demo must keep telling the truth: run it at full speed and check its outcome. */
import { describe, expect, it } from 'vitest'
import { runSwapDemo } from '../swap/swapDemo'
import { USDC } from '../swap/usdcChain'

describe('"Fay has only USDC" demo', () => {
  it('act 1 ends in a pledge from swapped sats; act 2 ends with the cheater refused and Fay refunded', async () => {
    const lines: string[] = []
    const r = await runSwapDemo({ log: l => lines.push(l) })
    expect(r.happy).toMatchObject({ usdcPaid: 100 * USDC, satsReceived: 2_150_000, lpUsdc: 100 * USDC, pledged: 1_000_000, secretRevealedOnBsv: true })
    expect(r.cheat.refused).toBe(true)
    expect(r.cheat.reason).toMatch(/less than the quoted/)
    expect(r.cheat.usdcBack).toBe(10 * USDC)
    expect(lines.join('\n')).toMatch(/all good/)
    expect(lines.filter(l => /^ {2}\d\./.test(l))).toHaveLength(11) // 8 + 3 narrated steps
  }, 300_000)
})
