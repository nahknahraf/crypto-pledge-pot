/** Shapes of the CryptoPledgePot indexer API, shared by the server, the client library and the UI. */
import type { CampaignMeta, CampaignStatus } from './campaign'

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
}

export interface CampaignView {
  id: string
  meta: CampaignMeta
  anchorTxid: string
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
  donorIdentity: string
  donorKey: string
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
