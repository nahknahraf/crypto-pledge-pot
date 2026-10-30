/**
 * The CryptoPledgePot agent service: an AI agent that raises its own operating budget
 * on CryptoPledgePot and spends it, milestone by milestone, on a pay-per-call data API.
 *
 * The agent's wallet is the campaign's creator wallet, so a milestone release
 * lands directly in its spendable balance (no contract changes needed).
 *
 * Each call to step() looks at the campaign and does the next sensible thing:
 *   no campaign        → launch one
 *   raising            → wait for backers
 *   milestone approved → release it (funds arrive in the agent's wallet)
 *   funds not yet used → plan purchases (brain), pay per call (capped payer),
 *                        log every payment, report to backers (opens the vote
 *                        on the next milestone)
 *   failed / done      → nothing to do; backers refund via CryptoPledgePot
 */
import type { WalletInterface } from '@bsv/sdk'
import type { CryptoPledgePot, LaunchInput } from '../client/cryptoPledgePot'
import type { CryptoPledgePotApi } from '../client/cryptoPledgePotApi'
import type { CampaignView } from '../core/api'
import { reportRecordScript } from '../core/campaign'
import type { Brain } from './brain'
import type { AirQualityReport, City } from './dataProvider'
import { Ledger, type AgentState, type Store } from './ledger'
import { PaidButNotServed, PaymentRefused, type PaidResponse } from './pay402'

export interface AgentConfig {
  /** What the service is for (shown to backers and given to the brain). */
  mission: string
  /** Campaign to launch if none exists yet. */
  campaign: LaunchInput
  /** Base URL of the paid data API, e.g. http://localhost:8790 */
  dataUrl: string
  /** Price the agent expects per call; the payer refuses anything higher. */
  pricePerCall: number
  /** Never spend more than this on one milestone's work. */
  maxSpendPerMilestone: number
  /** Always keep this much for transaction fees. */
  feeReserve: number
  /** Plan and log, but do not pay. */
  dryRun?: boolean
}

export interface AgentDeps {
  wallet: WalletInterface
  cryptopledgepot: CryptoPledgePot
  api: CryptoPledgePotApi
  brain: Brain
  ledger: Ledger
  state: Store<AgentState>
  /** Capped 402 payer (agent/pay402.ts). */
  pay: <T>(url: string) => Promise<PaidResponse<T>>
  log?: (line: string) => void
  /** Wallet originator (BRC-100 apps identify themselves by domain). */
  originator?: string
}

export type StepOutcome =
  | { action: 'launched', campaignId: string }
  | { action: 'waiting', reason: string }
  | { action: 'released', milestone: number, sats: number, txids: string[] }
  | { action: 'worked', milestone: number, calls: number, sats: number, report: string, updatePosted: boolean }
  | { action: 'stopped', reason: string }

export class CryptoPledgePotAgent {
  private readonly log: (line: string) => void

  constructor (readonly config: AgentConfig, readonly deps: AgentDeps) {
    this.log = deps.log ?? (line => console.log(`[agent] ${line}`))
  }

  async spendable (): Promise<number> {
    let total = 0
    for (let offset = 0; ; offset += 100) {
      const { outputs, totalOutputs } = await this.deps.wallet.listOutputs({ basket: 'default', limit: 100, offset }, this.deps.originator)
      for (const o of outputs) if (o.spendable) total += o.satoshis
      if (outputs.length === 0 || offset + outputs.length >= totalOutputs) break
    }
    return total
  }

  /** One decision. Safe to call repeatedly (e.g. every 30 s with --watch). */
  async step (): Promise<StepOutcome> {
    const state = this.deps.state.load()

    if (state.campaignId === undefined) {
      // Publish our own limits in the anchored terms, so anyone can audit our ledger against them.
      const { campaignId } = await this.deps.cryptopledgepot.launch({
        ...this.config.campaign,
        agentLimits: { pricePerCallSats: this.config.pricePerCall, maxSpendPerMilestoneSats: this.config.maxSpendPerMilestone }
      })
      this.deps.state.save({ ...state, campaignId })
      this.log(`launched campaign ${campaignId} — "${this.config.campaign.title}", goal ${this.config.campaign.goal} sats`)
      return { action: 'launched', campaignId }
    }

    const view = await this.deps.api.campaign(state.campaignId)
    if (view.status === 'active') return this.wait(`raising: ${view.raised}/${view.meta.goal} sats from ${view.donors} backer(s)`)
    if (view.status === 'failed') return this.stop('the campaign missed its goal; backers can reclaim their pledges')

    // 1) Spend funds that were released but not yet used.
    const unworked = view.milestones.find(m => m.released && !state.worked.includes(m.index))
    if (unworked !== undefined) return await this.work(view, unworked.index)

    // 2) Withdraw the next approved milestone.
    const ready = await this.deps.api.releasable(view.id)
    if (ready.milestone > 0 && ready.pledges.length > 0) {
      const r = await this.deps.cryptopledgepot.release(view.id)
      this.log(`released milestone ${r.milestone}: ${r.released} sats → agent wallet (${r.txids.join(', ')})`)
      return { action: 'released', milestone: r.milestone, sats: r.released, txids: r.txids }
    }

    if (view.status === 'completed') return this.stop(`all ${view.meta.milestones.length} milestones delivered; ${this.deps.ledger.totals().sats} sats spent on data in total`)
    const next = view.milestones.find(m => !m.released)
    return this.wait(next?.pending ?? 'waiting for the next milestone')
  }

  /** Spend one milestone's budget on data, log it, and report to backers. */
  private async work (view: CampaignView, milestone: number): Promise<StepOutcome> {
    const m = view.milestones[milestone - 1]
    const balance = await this.spendable()
    // The published cap is per milestone, across restarts and failed steps: subtract what the ledger already shows.
    const already = this.deps.ledger.forMilestone(milestone).reduce((t, e) => t + e.sats, 0)
    const budget = Math.max(0, Math.min(this.config.maxSpendPerMilestone - already, balance - this.config.feeReserve))
    const maxCalls = Math.floor(budget / this.config.pricePerCall)
    const bought = this.deps.ledger.all().map(e => e.topic)
    this.log(`milestone ${milestone} "${m.title}": balance ${balance} sats, budget ${budget} sats → up to ${maxCalls} calls`)

    const plan = await this.deps.brain.planCalls({ mission: this.config.mission, milestone: { index: milestone, title: m.title }, maxCalls, alreadyBought: bought })
    this.log(`brain (${this.deps.brain.name}) plans ${plan.length} purchase(s): ${plan.map(p => p.topic).join(', ') || 'none'}`)
    const results: AirQualityReport[] = []
    const txids: string[] = []
    let spent = 0
    for (const call of plan) {
      const url = `${this.config.dataUrl}/data/${call.topic}`
      if (spent + this.config.pricePerCall > budget) { this.log(`budget reached, skipping ${call.topic}`); break }
      if (this.config.dryRun === true) { this.log(`[dry run] would buy ${call.topic}: ${call.why}`); continue }
      try {
        const r = await this.deps.pay<AirQualityReport>(url)
        spent += r.paid
        results.push(r.body)
        if (r.txid !== undefined) txids.push(r.txid)
        this.deps.ledger.add({ milestone, topic: call.topic as City, why: call.why, url, sats: r.paid, txid: r.txid, at: Math.floor(Date.now() / 1000) })
        this.log(`paid ${r.paid} sats for ${call.topic} (AQI ${r.body.aqi}) tx ${r.txid ?? '-'}`)
      } catch (e) {
        if (e instanceof PaymentRefused) { this.log(`refused to pay: ${e.message}`); continue }
        if (e instanceof PaidButNotServed) {
          // The money is gone: record it (it counts against the cap) and move on; never pay twice for it.
          spent += e.paid
          if (e.txid !== undefined) txids.push(e.txid)
          this.deps.ledger.add({ milestone, topic: call.topic as City, why: call.why, url, sats: e.paid, txid: e.txid, at: Math.floor(Date.now() / 1000), failed: true })
          this.log(`paid ${e.paid} sats for ${call.topic} but got nothing: ${e.message}`)
          continue
        }
        throw e
      }
    }

    // Report every payment for this milestone from the ledger, not just this run's: after a failed
    // step or a restart, the earlier payments must still be in front of the backers.
    const paid = this.deps.ledger.forMilestone(milestone)
    spent = paid.reduce((t, e) => t + e.sats, 0)
    txids.splice(0, txids.length, ...paid.flatMap(e => e.txid !== undefined ? [e.txid] : []))
    const report = await this.deps.brain.writeReport({
      mission: this.config.mission,
      milestone: { index: milestone, title: m.title },
      results,
      spend: { calls: paid.length, sats: spent, txids }
    })
    // Report on the next milestone: that is what opens the backers' vote on it.
    const nextIndex = milestone + 1
    let updatePosted = false
    if (this.config.dryRun !== true && nextIndex <= view.meta.milestones.length) {
      const links = txids.map(t => `https://whatsonchain.com/tx/${t}`).join('\n')
      const text = `${report}\n\nPayments (${spent} sats):\n${links}`.slice(0, 3800)
      // Anchor the report's hash on chain before backers vote on it, so it can't be rewritten later.
      const anchor = await this.deps.wallet.createAction({
        description: 'Anchor agent milestone report',
        labels: ['cryptopledgepot', 'report'],
        outputs: [{ lockingScript: reportRecordScript(view.id, nextIndex, text, view.protocolTag).toHex(), satoshis: 0, outputDescription: 'report hash' }],
        options: { acceptDelayedBroadcast: false }
      }, this.deps.originator)
      if (anchor.txid === undefined) throw new Error('the report anchor was not broadcast; not posting the report')
      await this.deps.cryptopledgepot.postUpdate(view.id, nextIndex, `${text}\n\nReport anchored on chain: https://whatsonchain.com/tx/${anchor.txid}`)
      updatePosted = true
      this.log(`posted progress report (hash anchored in ${anchor.txid.slice(0, 12)}…); backers can now vote on milestone ${nextIndex}`)
    }
    if (this.config.dryRun !== true) {
      const s = this.deps.state.load()
      this.deps.state.save({ ...s, worked: [...s.worked, milestone] })
    }
    return { action: 'worked', milestone, calls: results.length, sats: spent, report, updatePosted }
  }

  private wait (reason: string): StepOutcome { this.log(`waiting — ${reason}`); return { action: 'waiting', reason } }
  private stop (reason: string): StepOutcome { this.log(`done — ${reason}`); return { action: 'stopped', reason } }
}

export { Ledger }
