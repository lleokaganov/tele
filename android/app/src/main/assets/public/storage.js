// Persistent chat storage on top of DB.js (IndexedDB wrapper).
//
// Tables:
//   messages   { id, peer_id, dir, body, ts, status }
//                body is plain text for chat; if it starts with '%' the
//                remainder is a file_id pointing into the files table.
//   outbox     { id, attempts, last_try_ts }
//                mirror of pending out-messages for fast retry. Removed
//                on DELIVERY_ACK.
//   files      { id, mime, name, size, blob, thumb_blob }
//                actual file bytes — populated by Stage B (chunked transfer).

const DB_NAME = 'telefon.lleo.me'
const TABLES  = ['messages', 'outbox', 'files']

export const Storage = {
  // ---- lifecycle ----
  async init() {
    // navigator.storage.estimate is handy info; never blocks startup.
    try {
      const r = await DB.free()
      console.info('IDB free:', r.s || '(unavailable)')
    } catch {}
    console.log('[boot] db_exist?')
    const exists = await DB.db_exist(DB_NAME)
    console.log('[boot] db_exist =', exists)
    if (!exists) { await DB.add_db(DB_NAME); console.log('[boot] db created') }
    for (const t of TABLES) {
      console.log('[boot] table', t)
      if (!await DB.table_exist(DB_NAME, t)) await DB.add_table(DB_NAME, t, 'id')
    }
    console.log('[boot] storage init complete')
  },

  // ---- messages ----

  /** Save a freshly-typed outgoing text. Returns the assigned id. */
  async saveOutgoing(peerId, body) {
    const id = crypto.randomUUID()
    const ts = Date.now()
    await DB.add(DB_NAME, 'messages', { id, peer_id: peerId, dir: 'out', body, ts, status: 'pending' })
    await DB.add(DB_NAME, 'outbox',   { id, attempts: 0, last_try_ts: 0 })
    return id
  },

  /** Save an incoming text. Idempotent: if a message with this id already
   *  exists, do nothing (peer might retry on its end and resend). */
  async saveIncoming(peerId, id, body, ts) {
    const existing = await DB.get(DB_NAME, 'messages', id)
    if (existing) return false
    await DB.add(DB_NAME, 'messages', {
      id, peer_id: peerId, dir: 'in', body,
      ts: ts || Date.now(), status: 'received',
    })
    return true
  },

  /** Update the lifecycle state of an out-message. */
  async markStatus(id, status) {
    const m = await DB.get(DB_NAME, 'messages', id)
    if (!m) return
    m.status = status
    await DB.add(DB_NAME, 'messages', m)  // 'replace' mode
    if (status === 'delivered' || status === 'read') {
      // Removed from the retry queue.
      await DB.del(DB_NAME, 'outbox', id)
    }
  },

  /** Return the full chat with a peer, oldest first. */
  async history(peerId) {
    const rows = await DB.get(DB_NAME, 'messages', (m) => m.peer_id === peerId)
    rows.sort((a, b) => a.ts - b.ts)
    return rows
  },

  /** Return the most recent `limit` messages with a peer, oldest first.
   *  Backs the windowed chat view so opening a long conversation only
   *  renders a tail instead of the whole thing. Fetch-all + slice is fine
   *  at our scale (a phone-to-phone chat, not a public channel). */
  async historyTail(peerId, limit) {
    const rows = await this.history(peerId)
    return limit && rows.length > limit ? rows.slice(-limit) : rows
  },

  /** Return up to `limit` messages at-or-older-than `beforeTs`, the newest of
   *  that set, oldest first. Used to lazy-load upward as the user scrolls
   *  toward the top of the chat. The bound is inclusive (<=) so messages
   *  sharing the boundary timestamp are never skipped; the caller dedupes by
   *  id against what's already on screen to avoid re-rendering the boundary
   *  row. */
  async historyBefore(peerId, beforeTs, limit) {
    const rows = await DB.get(DB_NAME, 'messages',
      (m) => m.peer_id === peerId && m.ts <= beforeTs)
    rows.sort((a, b) => a.ts - b.ts)
    return limit && rows.length > limit ? rows.slice(-limit) : rows
  },

  /** Full-text search over a peer's conversation. Matches text bodies that
   *  contain `query` (case-insensitive). File references (bodies starting
   *  with '%') are skipped — their body is an opaque id, not searchable
   *  text. Oldest first. */
  async search(peerId, query) {
    const q = (query || '').trim().toLowerCase()
    if (!q) return []
    const rows = await this.history(peerId)
    return rows.filter((m) =>
      !isFileRef(m.body) && m.body.toLowerCase().includes(q))
  },

  /** Outbox entries that target a particular peer. Joins with messages
   *  on id so the caller gets the full payload back. */
  async pendingFor(peerId) {
    const queue = await DB.get(DB_NAME, 'outbox', () => true)
    if (queue.length === 0) return []
    // Fetch each message and filter by peer. With proper indexes this
    // would be one range query; cursor-scan is fine at our scale.
    const out = []
    for (const q of queue) {
      const m = await DB.get(DB_NAME, 'messages', q.id)
      if (m && m.peer_id === peerId && m.dir === 'out') {
        out.push({ ...m, attempts: q.attempts })
      }
    }
    out.sort((a, b) => a.ts - b.ts)
    return out
  },

  /** Bump retry counter for an outbox entry. */
  async bumpAttempt(id) {
    const q = await DB.get(DB_NAME, 'outbox', id)
    if (!q) return
    q.attempts += 1
    q.last_try_ts = Date.now()
    await DB.add(DB_NAME, 'outbox', q)
  },

  /** Delete a single message by id. Also removes its outbox entry and,
   *  when the body is a file reference, the underlying file blob. */
  async deleteMessage(id) {
    const m = await DB.get(DB_NAME, 'messages', id)
    if (!m) return
    if (isFileRef(m.body)) {
      try { await DB.del(DB_NAME, 'files', fileIdOf(m.body)) } catch {}
    }
    await DB.del(DB_NAME, 'messages', id)
    try { await DB.del(DB_NAME, 'outbox', id) } catch {}
  },

  /** Replace the text body of a message in place. No-op for file refs. */
  async editMessage(id, newBody) {
    const m = await DB.get(DB_NAME, 'messages', id)
    if (!m) return false
    if (isFileRef(m.body)) return false
    m.body = newBody
    m.edited = true
    await DB.add(DB_NAME, 'messages', m)  // 'replace' mode
    return true
  },

  /** Remove the entire conversation with a peer (messages + their files
   *  + any pending outbox entries). Local only. */
  async clearHistory(peerId) {
    const rows = await DB.get(DB_NAME, 'messages', (m) => m.peer_id === peerId)
    for (const m of rows) {
      if (isFileRef(m.body)) {
        try { await DB.del(DB_NAME, 'files', fileIdOf(m.body)) } catch {}
      }
      await DB.del(DB_NAME, 'messages', m.id)
      try { await DB.del(DB_NAME, 'outbox', m.id) } catch {}
    }
    return rows.length
  },

  /** Drop everything (for "wipe identity"). */
  async wipe() {
    for (const t of TABLES) {
      try { await DB.truncate(DB_NAME, t) } catch {}
    }
  },

  // ---- files ----

  /** Insert file metadata before chunks start arriving. The blob is
   *  filled in later via `saveFileBlob`. */
  async saveFileMeta(meta) {
    await DB.add(DB_NAME, 'files', {
      id: meta.id, mime: meta.mime, name: meta.name, size: meta.size,
      blob: null, thumb_blob: meta.thumb_blob || null,
    })
  },
  /** Finalise: store the fully-assembled blob. */
  async saveFileBlob(fileId, blob) {
    const f = await DB.get(DB_NAME, 'files', fileId)
    if (!f) return
    f.blob = blob
    await DB.add(DB_NAME, 'files', f)
  },
  async getFile(fileId) {
    return await DB.get(DB_NAME, 'files', fileId)
  },
}

// Convenience helpers exposed for app.js without exporting DB itself.
export const isFileRef = (body) => typeof body === 'string' && body.startsWith('%')
export const fileIdOf  = (body) => isFileRef(body) ? body.slice(1) : null
