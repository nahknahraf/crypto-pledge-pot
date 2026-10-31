/**
 * The donor agent's messages to its donor: questions it needs answered
 * ("nothing fits this month, which of these?") and plain updates ("gave 5,000
 * sats to …"). Kept in a file next to the memos and optionally pushed to the
 * donor's phone through a webhook (donor/main.ts).
 */
import type { Store } from '../agent/ledger'

export interface Option { campaignId: string, title: string, relevance: number, summary: string }

export interface Message {
  id: string
  at: number
  kind: 'question' | 'info'
  planId?: string
  installment?: number
  text: string
  /** Questions: campaigns to choose from (the donor may also answer "skip"). */
  options?: Option[]
  /** Questions: open until answered or expired; info messages are 'info'. */
  status: 'open' | 'answered' | 'expired' | 'info'
  expiresAt?: number
  /** A campaign id from `options`, or 'skip'. */
  answer?: string
}

export class Inbox {
  constructor (private readonly store: Store<Message[]>) {}

  all (): Message[] { return this.store.load() }
  get (id: string): Message | undefined { return this.all().find(m => m.id === id) }
  open (): Message[] { return this.all().filter(m => m.status === 'open') }

  add (m: Omit<Message, 'id' | 'at'>, now: number): Message {
    const all = this.all()
    const msg: Message = { ...m, id: `q${all.length + 1}`, at: now }
    this.store.save([...all, msg])
    return msg
  }

  update (id: string, patch: Partial<Message>): Message {
    const all = this.all()
    const i = all.findIndex(m => m.id === id)
    if (i < 0) throw new Error(`no message ${id}`)
    all[i] = { ...all[i], ...patch, id: all[i].id, at: all[i].at }
    this.store.save(all)
    return all[i]
  }
}
