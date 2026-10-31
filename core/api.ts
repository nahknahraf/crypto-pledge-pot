/** Shapes of the CryptoPledgePot indexer API, shared by the server, the client library and the UI. */
import type { CampaignMeta, CampaignStatus, ProtocolTag } from './campaign'
import type { SpendingResult } from './paymentPlan'
import type { MilestoneCompliance } from './compliance'

export interface MilestoneView {
  index: number // 1-based
  title: string
  percent: number
  released: boolean
  releaseTxids: string[]
  /** Creator's progress report for this milestone (needed before a vote, milestone 2+). */
  update?: { note: string, createdAt: number }
  votes: { yes: number, no: number, voters: number }
  /** True when the arbiter will co-sign this milestone's release. */
  approved: boolean
  /** Why it is not approved yet. */
  pending?: string
  /** Campaigns with a payment plan, released milestones: verified spending against the plan. */
  spending?: SpendingResult
  /** Campaigns with a payment plan, released milestones: did the creator keep the plan? */
  compliance?: MilestoneCompliance
}

/** What a donor can collect: a repayment output paying one of their pledges' donor keys. */
export interface RepaymentView { campaignId: string, campaignTitle: string, milestone: number, outpoint: string, pledgeId: string, sats: number, donorKey: string, donorKeyId: string, beef: string }

/** A verified expense against a payment plan line. */
export interface SpendView {
  milestone: number
  lineId: string
  outpoint: string | null
  invoiceSha256: string | null
  note: string | null
  verifiedSats: number
  reason: string
  createdAt: number
}

export interface CampaignView {
  id: string
  meta: CampaignMeta
  anchorTxid: string
  /** 'bitfund' for campaigns made before the rename (keys derived with the old names). */
  protocolTag: ProtocolTag
  status: CampaignStatus
  /** Satoshis pledged and not refunded. */
  raised: number
  /** Satoshis already released to the creator. */
  released: number
  /** Satoshis still escrowed. */
  escrowed: number
  donors: number
  pledges: number
  milestonesReleased: number
  milestones: MilestoneView[]
}

export interface PledgeView {
  id: string
  campaignId: string
  /** '' while an imported pledge is unclaimed (see /api/pledges/:id/claim). */
  donorIdentity: string
  donorKey: string
  /** '' while unknown (imported from chain); the donor's wallet basket has it. */
  donorKeyId: string
  amount: number
  name: string | null
  message: string | null
  createdAt: number
  outpoint: string
  stage: number
  status: 'active' | 'released' | 'refunded'
  /** Satoshis still in the escrow output. */
  escrowed: number
  spentBy: string | null
}

export interface CampaignDetail extends CampaignView {
  feed: PledgeView[]
}

export interface ReleasablePledges {
  /** Milestone these pledges would release (1-based). */
  milestone: number
  pledges: PledgeView[]
  /** BEEF (hex) containing every pledge's current escrow transaction. */
  beef: string
}

export interface SpendablePledge {
  pledge: PledgeView
  /** AtomicBEEF (hex) of the transaction holding the current escrow output. */
  beef: string
}

export type CampaignEvent =
  | { type: 'pledge', pledge: PledgeView }
  | { type: 'release', milestone: number, txid: string, amount: number }
  | { type: 'refund', pledgeId: string, txid: string }
  | { type: 'vote', milestone: number }
  | { type: 'update', milestone: number }
  | { type: 'spending', milestone: number }
  | { type: 'repayment', milestone: number, txid: string, sats: number }
