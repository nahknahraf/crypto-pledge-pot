'use strict'
// The subset of the better-sqlite3 API that knex's 'better-sqlite3' client and
// wallet-toolbox use, implemented with Node's built-in node:sqlite.
const { DatabaseSync } = require('node:sqlite')

class Statement {
  constructor (stmt) {
    this.stmt = stmt
    this.reader = stmt.columns().length > 0
  }

  safeIntegers (on = true) { this.stmt.setReadBigInts(on); return this }
  all (params = []) { return this.stmt.all(...toArgs(params)).map(plain) }
  get (params = []) { const r = this.stmt.get(...toArgs(params)); return r === undefined ? r : plain(r) }
  run (params = []) {
    const r = this.stmt.run(...toArgs(params))
    return { changes: Number(r.changes), lastInsertRowid: r.lastInsertRowid }
  }
}

class Database {
  constructor (filename = ':memory:', options = {}) {
    this.db = new DatabaseSync(filename, { readOnly: !!options.readonly })
    this.name = filename
    this.open = true
    this._safe = false
  }

  defaultSafeIntegers (on = true) { this._safe = on; return this }
  prepare (sql) {
    const s = new Statement(this.db.prepare(sql))
    if (this._safe) s.safeIntegers(true)
    return s
  }

  exec (sql) { this.db.exec(sql); return this }
  pragma (sql) { return this.prepare(`PRAGMA ${sql}`).all() }
  close () { this.db.close(); this.open = false; return this }
}

const toArgs = p => (Array.isArray(p) ? p : [p]).map(v => v instanceof Buffer || v instanceof Uint8Array ? v : v === undefined ? null : v)
// node:sqlite returns null-prototype rows and Uint8Array blobs; better-sqlite3 returns plain objects and Buffers.
const plain = row => {
  const o = {}
  for (const k of Object.keys(row)) { const v = row[k]; o[k] = v instanceof Uint8Array ? Buffer.from(v.buffer, v.byteOffset, v.byteLength) : v }
  return o
}

module.exports = Database
module.exports.default = Database
