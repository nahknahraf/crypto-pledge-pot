/**
 * CryptoPledgePot indexer storage (knex; SQLite by default, MySQL/Postgres work too).
 *
 * The chain is the source of truth for money; this index makes it fast to
 * browse campaigns and keeps the BEEF needed to spend each escrow.
 */
import knexPkg, { type Knex } from 'knex'
import type { CampaignMeta, ProtocolTag } from '../core/campaign'
import { ownerKey, type Routine } from '../core/routines'

export interface CampaignRow { id: string, meta: CampaignMeta, creatorIdentity: string, anchorTxid: string, createdAt: number, protocolTag: ProtocolTag }

export type PledgeStatus = 'active' | 'released' | 'refunded'

export interface PledgeRow {
  /** Outpoint of the original donation, `txid.vout`. */
  id: string
  campaignId: string
  donorIdentity: string
  donorKey: string
  /** keyID the donor's wallet derived donorKey with (DONOR_PROTOCOL, counterparty 'self'). Not secret. */
  donorKeyId: string
  amount: number
  name: string | null
  message: string | null
  createdAt: number
  /** Where the escrow lives now (moves with every milestone release). */
  outpoint: string
  stage: number
  status: PledgeStatus
  /** Transaction that spent it last (release or refund). */
  spentBy: string | null
}

export interface ReleaseRow { campaignId: string, milestone: number, txid: string, amount: number, createdAt: number }
export interface UpdateRow { campaignId: string, milestone: number, note: string, createdAt: number }
export interface VoteRow { campaignId: string, milestone: number, voter: string, approve: boolean, createdAt: number }

// knex is CommonJS: take the factory from the default export so plain Node ESM (tsx) works too.
const makeKnex = ((knexPkg as any).knex ?? knexPkg) as typeof knexPkg

export const sqliteKnex = (filename: string): Knex =>
  makeKnex({ client: 'better-sqlite3', connection: { filename }, useNullAsDefault: true, pool: { min: 1, max: 1 } })

export class CryptoPledgePotDb {
  constructor (readonly knex: Knex) {}

  async migrate (): Promise<void> {
    const k = this.knex
    if (!(await k.schema.hasTable('campaigns'))) {
      await k.schema.createTable('campaigns', t => {
        t.string('id', 64).primary()
        t.text('meta').notNullable()
        t.string('creator_identity', 66).notNullable().index()
        t.string('anchor_txid', 64).notNullable()
        t.integer('created_at').notNullable()
        t.string('protocol_tag', 32).notNullable().defaultTo('cryptopledgepot')
      })
    } else if (!(await k.schema.hasColumn('campaigns', 'protocol_tag'))) {
      // Databases created before legacy-tag support: every campaign in them used the current tag.
      await k.schema.alterTable('campaigns', t => { t.string('protocol_tag', 32).notNullable().defaultTo('cryptopledgepot') })
    }
    if (!(await k.schema.hasTable('pledges'))) {
      await k.schema.createTable('pledges', t => {
        t.string('id', 80).primary()
        t.string('campaign_id', 64).notNullable().index()
        t.string('donor_identity', 66).notNullable().index()
        t.string('donor_key', 66).notNullable()
        t.string('donor_key_id', 64).notNullable()
        t.bigInteger('amount').notNullable()
        t.string('name', 80)
        t.string('message', 600)
        t.integer('created_at').notNullable()
        t.string('outpoint', 80).notNullable().unique()
        t.integer('stage').notNullable()
        t.string('status', 16).notNullable()
        t.string('spent_by', 64)
      })
    }
    if (!(await k.schema.hasTable('txs'))) {
      await k.schema.createTable('txs', t => {
        t.string('txid', 64).primary()
        t.text('beef').notNullable() // AtomicBEEF hex
      })
    }
    if (!(await k.schema.hasTable('releases'))) {
      await k.schema.createTable('releases', t => {
        t.increments('id')
        t.string('campaign_id', 64).notNullable().index()
        t.integer('milestone').notNullable()
        t.string('txid', 64).notNullable().unique()
        t.bigInteger('amount').notNullable()
        t.integer('created_at').notNullable()
      })
    }
    if (!(await k.schema.hasTable('milestone_updates'))) {
      await k.schema.createTable('milestone_updates', t => {
        t.string('campaign_id', 64).notNullable()
        t.integer('milestone').notNullable()
        t.text('note').notNullable()
        t.integer('created_at').notNullable()
        t.primary(['campaign_id', 'milestone'])
      })
    }
    if (!(await k.schema.hasTable('votes'))) {
      await k.schema.createTable('votes', t => {
        t.string('campaign_id', 64).notNullable()
        t.integer('milestone').notNullable()
        t.string('voter', 66).notNullable()
        t.boolean('approve').notNullable()
        t.integer('created_at').notNullable()
        t.primary(['campaign_id', 'milestone', 'voter'])
      })
    }
    if (!(await k.schema.hasTable('routines'))) {
      // Giving routines (core/routines.ts). The routine is stored as JSON: it is
      // only ever read whole, by its owner. `owner` is ownerKey(owner), e.g.
      // "brc103:<identity key>" today and "zk:<commitment>" once ZK auth lands.
      await k.schema.createTable('routines', t => {
        t.string('id', 32).primary()
        t.string('owner', 140).notNullable().index()
        t.text('data').notNullable()
        t.integer('created_at').notNullable()
      })
    }
    if (!(await k.schema.hasColumn('routines', 'executor'))) {
      // The routine agent a routine is delegated to (its identity key), so the agent can list its work.
      await k.schema.alterTable('routines', t => { t.string('executor', 66).index() })
    }
  }

  // ── campaigns ──
  async insertCampaign (c: CampaignRow): Promise<void> {
    await this.knex('campaigns').insert({ id: c.id, meta: JSON.stringify(c.meta), creator_identity: c.creatorIdentity, anchor_txid: c.anchorTxid, created_at: c.createdAt, protocol_tag: c.protocolTag })
  }

  async campaign (id: string): Promise<CampaignRow | undefined> {
    const r = await this.knex('campaigns').where({ id }).first()
    return r === undefined ? undefined : campaignFromRow(r)
  }

  async campaigns (): Promise<CampaignRow[]> {
    return (await this.knex('campaigns').orderBy('created_at', 'desc')).map(campaignFromRow)
  }

  // ── pledges ──
  async insertPledge (p: PledgeRow): Promise<void> {
    await this.knex('pledges').insert(pledgeToRow(p))
  }

  async pledge (id: string): Promise<PledgeRow | undefined> {
    const r = await this.knex('pledges').where({ id }).first()
    return r === undefined ? undefined : pledgeFromRow(r)
  }

  async pledgeAt (outpoint: string): Promise<PledgeRow | undefined> {
    const r = await this.knex('pledges').where({ outpoint }).first()
    return r === undefined ? undefined : pledgeFromRow(r)
  }

  async pledges (campaignId: string, filter: { donorIdentity?: string, status?: PledgeStatus } = {}): Promise<PledgeRow[]> {
    const q = this.knex('pledges').where({ campaign_id: campaignId })
    if (filter.donorIdentity !== undefined) q.andWhere({ donor_identity: filter.donorIdentity })
    if (filter.status !== undefined) q.andWhere({ status: filter.status })
    return (await q.orderBy('created_at', 'desc')).map(pledgeFromRow)
  }

  async activePledges (): Promise<PledgeRow[]> {
    return (await this.knex('pledges').where({ status: 'active' })).map(pledgeFromRow)
  }

  async pledgesByDonor (donorIdentity: string): Promise<PledgeRow[]> {
    return (await this.knex('pledges').where({ donor_identity: donorIdentity }).orderBy('created_at', 'desc')).map(pledgeFromRow)
  }

  async updatePledge (id: string, patch: Partial<Pick<PledgeRow, 'outpoint' | 'stage' | 'status' | 'spentBy' | 'donorIdentity' | 'donorKeyId'>>): Promise<void> {
    const row: Record<string, unknown> = {}
    if (patch.donorIdentity !== undefined) row.donor_identity = patch.donorIdentity
    if (patch.donorKeyId !== undefined) row.donor_key_id = patch.donorKeyId
    if (patch.outpoint !== undefined) row.outpoint = patch.outpoint
    if (patch.stage !== undefined) row.stage = patch.stage
    if (patch.status !== undefined) row.status = patch.status
    if (patch.spentBy !== undefined) row.spent_by = patch.spentBy
    await this.knex('pledges').where({ id }).update(row)
  }

  // ── transactions ──
  async putTx (txid: string, beefHex: string): Promise<void> {
    await this.knex('txs').insert({ txid, beef: beefHex }).onConflict('txid').ignore()
  }

  async tx (txid: string): Promise<string | undefined> {
    return (await this.knex('txs').where({ txid }).first())?.beef
  }

  // ── milestones ──
  async insertRelease (r: ReleaseRow): Promise<void> {
    await this.knex('releases').insert({ campaign_id: r.campaignId, milestone: r.milestone, txid: r.txid, amount: r.amount, created_at: r.createdAt })
  }

  async releases (campaignId: string): Promise<ReleaseRow[]> {
    return (await this.knex('releases').where({ campaign_id: campaignId }).orderBy('id', 'asc'))
      .map(r => ({ campaignId: r.campaign_id, milestone: r.milestone, txid: r.txid, amount: Number(r.amount), createdAt: r.created_at }))
  }

  async putUpdate (u: UpdateRow): Promise<void> {
    await this.knex('milestone_updates').insert({ campaign_id: u.campaignId, milestone: u.milestone, note: u.note, created_at: u.createdAt })
      .onConflict(['campaign_id', 'milestone']).merge(['note', 'created_at'])
  }

  async updates (campaignId: string): Promise<UpdateRow[]> {
    return (await this.knex('milestone_updates').where({ campaign_id: campaignId }))
      .map(r => ({ campaignId: r.campaign_id, milestone: r.milestone, note: r.note, createdAt: r.created_at }))
  }

  async putVote (v: VoteRow): Promise<void> {
    await this.knex('votes').insert({ campaign_id: v.campaignId, milestone: v.milestone, voter: v.voter, approve: v.approve, created_at: v.createdAt })
      .onConflict(['campaign_id', 'milestone', 'voter']).merge(['approve', 'created_at'])
  }

  async votes (campaignId: string): Promise<VoteRow[]> {
    return (await this.knex('votes').where({ campaign_id: campaignId }))
      .map(r => ({ campaignId: r.campaign_id, milestone: r.milestone, voter: r.voter, approve: Boolean(r.approve), createdAt: r.created_at }))
  }

  // ── giving routines ──
  async putRoutine (r: Routine): Promise<void> {
    await this.knex('routines').insert({ id: r.id, owner: ownerKey(r.owner), executor: r.executor?.identityKey ?? null, data: JSON.stringify(r), created_at: r.createdAt })
      .onConflict('id').merge(['data', 'executor'])
  }

  async routine (id: string): Promise<Routine | undefined> {
    const r = await this.knex('routines').where({ id }).first()
    return r === undefined ? undefined : JSON.parse(r.data)
  }

  async routinesOf (owner: string): Promise<Routine[]> {
    return (await this.knex('routines').where({ owner }).orderBy('created_at', 'desc')).map(r => JSON.parse(r.data))
  }

  /** Routines delegated to this routine agent (identity key). */
  async routinesExecutedBy (executor: string): Promise<Routine[]> {
    return (await this.knex('routines').where({ executor }).orderBy('created_at', 'asc')).map(r => JSON.parse(r.data))
  }

  async transaction<T> (fn: (db: CryptoPledgePotDb) => Promise<T>): Promise<T> {
    return await this.knex.transaction(async trx => await fn(new CryptoPledgePotDb(trx)))
  }
}

const campaignFromRow = (r: any): CampaignRow => ({ id: r.id, meta: JSON.parse(r.meta), creatorIdentity: r.creator_identity, anchorTxid: r.anchor_txid, createdAt: r.created_at, protocolTag: r.protocol_tag ?? 'cryptopledgepot' })

const pledgeToRow = (p: PledgeRow): Record<string, unknown> => ({
  id: p.id,
  campaign_id: p.campaignId,
  donor_identity: p.donorIdentity,
  donor_key: p.donorKey,
  donor_key_id: p.donorKeyId,
  amount: p.amount,
  name: p.name,
  message: p.message,
  created_at: p.createdAt,
  outpoint: p.outpoint,
  stage: p.stage,
  status: p.status,
  spent_by: p.spentBy
})

const pledgeFromRow = (r: any): PledgeRow => ({
  id: r.id,
  campaignId: r.campaign_id,
  donorIdentity: r.donor_identity,
  donorKey: r.donor_key,
  donorKeyId: r.donor_key_id,
  amount: Number(r.amount),
  name: r.name,
  message: r.message,
  createdAt: r.created_at,
  outpoint: r.outpoint,
  stage: r.stage,
  status: r.status,
  spentBy: r.spent_by
})
