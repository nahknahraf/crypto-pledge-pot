/**
 * The zero-click run's layout, shared by `npm run agents:mainnet` (launcher) and `npm run agents:fund` (funding):
 * which agents run where, with which mandate, and how many sats each one gets from the team treasury.
 * Amounts are deliberately tiny: the fundraising agent's goal is 1,200 sats (fundraising-agent/campaignPlan.ts).
 */
import fs from 'node:fs'
import path from 'node:path'
import type { FundTarget } from '../shared/treasury'

export interface DonorSpec { slug: string, name: string, interests: string, port: number }

export const ZERO_CLICK = {
  serverPort: 8787,
  dataPort: 8790,
  agentPort: 8791,
  /** The fundraising agent's fee float. Its campaign goal is derived separately (1,200 sats). */
  agentFunding: 2_000,
  agentFeeReserve: 500,
  // Sized so ANY 2 of the 3 donor agents at a passing score (60–74 → half of perPledgeMax) reach the 1,200-sat goal.
  // Mainnet run 1 (2026-10-31) used 1,000: two said yes, one declined (score 55), and 1,000 < 1,200 failed the goal.
  donorFunding: 2_000,
  donorBudget: { totalSats: 1_600, perPledgeMaxSats: 1_600, perCreatorMaxPct: 100 },
  donors: [
    { slug: 'ai-accountability', name: 'AI-accountability donor', interests: 'autonomous AI agents that publish every payment and stay within their published spending limits', port: 8792 },
    { slug: 'micropayments', name: 'Micropayments donor', interests: 'machine-to-machine micropayments on BSV: agents paying per API call, every payment on chain', port: 8794 },
    { slug: 'open-data', name: 'Open-data donor', interests: 'open air-quality data published for anyone, bought transparently with every purchase on chain', port: 8796 }
  ] satisfies DonorSpec[],
  /** Sats to keep in the treasury for the funding transactions' fees. */
  feeMargin: 1_000
} as const

export const donorDir = (d: DonorSpec, root = 'data'): string => path.resolve(root, 'donors', d.slug)
export const totalFunding = (): number => ZERO_CLICK.agentFunding + ZERO_CLICK.donors.length * ZERO_CLICK.donorFunding
export const depositNeeded = (): number => totalFunding() + ZERO_CLICK.feeMargin

/** Write a donor agent's autopilot mandate if it has none (an existing one is the owner's and is left alone). */
export function ensureDonorMandate (d: DonorSpec, root = 'data'): string {
  const file = path.join(donorDir(d, root), 'donor-mandate.json')
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ name: d.name, mode: 'autopilot', interests: d.interests, keywords: ['agent', 'data', 'payment'], budget: ZERO_CLICK.donorBudget, memo: { name: d.name } }, null, 2) + '\n')
  }
  return file
}

/** Who the treasury pays, and how much, through each agent's own status page and fund endpoint. */
export function fundTargets (host = 'http://127.0.0.1'): FundTarget[] {
  return [
    { name: 'fundraising agent', statusUrl: `${host}:${ZERO_CLICK.agentPort}/api/agent`, fundUrl: `${host}:${ZERO_CLICK.agentPort}/api/agent/fund`, sats: ZERO_CLICK.agentFunding },
    ...ZERO_CLICK.donors.map(d => ({ name: d.name, statusUrl: `${host}:${d.port}/api/donor`, fundUrl: `${host}:${d.port}/api/donor/fund`, sats: ZERO_CLICK.donorFunding }))
  ]
}
