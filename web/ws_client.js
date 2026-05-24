// Thin JS wrapper: WebSocket + WsSession. The WASM module owns all
// cryptographic state; this layer just routes bytes between the wire
// and the session, and surfaces high-level events to UI code.

import init, { WsSession } from './ws_wasm.js'

// Same-origin endpoint: an nginx vhost in front of the page proxies `/ws`
// to the local ws_server, so wss matches the page scheme and there is no
// cross-origin path at all.
// In a Capacitor native build the page is served from a local scheme
// (localhost/capacitor), so same-origin would point nowhere. Detect native
// and target the real server explicitly; in the browser PWA keep same-origin.
const NATIVE = typeof window !== 'undefined'
  && window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function'
  && window.Capacitor.isNativePlatform()
const NATIVE_HOST = 'tele.karlson.ru'
const DEFAULT_URL = NATIVE
  ? `wss://${NATIVE_HOST}/ws`
  : (typeof location !== 'undefined'
      ? `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`
      : 'ws://localhost/ws')
const RECONNECT_MIN_MS = 1000
const RECONNECT_MAX_MS = 30000

// Reserved cmd codes (must match doc/PROTOCOL.md).
export const CMD = {
  TEXT:            0x20,
  SOUND_START:     0x21,
  SOUND_STOP:      0x22,
  SOUND_STOP_ALL:  0x23,
  SUBSCRIBE:       0x40,
  UNSUBSCRIBE:     0x41,
  PEER_ONLINE:     0x42,
  PEER_OFFLINE:    0x43,
  INTRODUCE:       0x46,
  INTRO_FROM:      0x47,
  WAKE:            0x48,
  PUSH_REGISTER:   0x49,
  DELIVERY_ACK:    0x27,
  FILE_OFFER:      0x24,
  FILE_CHUNK:      0x25,
  FILE_END:        0x26,
  MSG_DELETE:      0x28,
  MSG_EDIT:        0x29,
  READ_ACK:        0x2A,
  INFO:            0x88,   // server-originated plain-text notice → shown to user
  ERROR:           0xFF,
}

// Error codes carried in handshake-reply body when cmd=ERROR.
export const ERR = {
  ID_IN_USE:           0x01,
  BAD_VERSION:         0x02,
  RECIPIENT_OFFLINE:   0x03,
}

let wasmReady = null
function ensureWasm() {
  if (!wasmReady) wasmReady = init()
  return wasmReady
}

export class WsClient {
  /**
   * @param {object} opts
   * @param {string} [opts.url] - WS endpoint, default ws://ws.lleo.me/api0
   * @param {Uint8Array} [opts.xSeed] - persisted X25519 seed (32 bytes). If absent, a fresh one is generated.
   * @param {Uint8Array} [opts.edSeed] - persisted Ed25519 seed (32 bytes). If absent, a fresh one is generated.
   */
  constructor(opts = {}) {
    this.url = opts.url || DEFAULT_URL
    this.xSeed = opts.xSeed || null
    this.edSeed = opts.edSeed || null
    this.session = null
    this.ws = null
    this.serverXPub = opts.serverXPub || null  // optional self-hosted relay keys
    this.serverEdPub = opts.serverEdPub || null
    this.msgIdCounter = 1
    this.reconnectMs = RECONNECT_MIN_MS
    this.closedManually = false

    // Public callbacks the host page wires up.
    this.onState = (_state) => {}
    this.onConsole = (_line) => {}
    this.onPeer = (_msg) => {}     // { from_id: Uint8Array(8), cmd, body: Uint8Array }
    this.onServer = (_msg) => {}    // { cmd, body }
  }

  // ---- lifecycle ----

  async init() {
    await ensureWasm()
    if (this.xSeed && this.edSeed) {
      this.session = WsSession.from_seeds(this.xSeed, this.edSeed)
    } else {
      this.session = new WsSession()
    }
    // Optional self-hosted relay: override the baked-in server keys.
    if (this.serverXPub && this.serverEdPub) {
      try { this.session.setServerKeys(this.serverXPub, this.serverEdPub) }
      catch (e) { console.warn('setServerKeys failed', e) }
    }
  }

  async connect() {
    if (!this.session) await this.init()
    this.closedManually = false
    this._open()
  }

  close() {
    this.closedManually = true
    this.ws && this.ws.close(1000, 'manual')
    this.ws = null
  }

  // ---- WS plumbing ----

  _open() {
    const ws = new WebSocket(this.url)
    ws.binaryType = 'arraybuffer'
    this.ws = ws
    this._setState('connecting', this.url)

    ws.onopen = () => {
      this._setState('handshaking')
      const frame = this.session.buildHandshake()
      console.log('[wsclient] onopen, sending handshake', frame.length, 'bytes')
      ws.send(frame)
    }
    ws.addEventListener('close', (e) => console.log('[wsclient] close', e.code, e.reason))
    ws.addEventListener('error', () => console.log('[wsclient] error'))
    ws.onmessage = (ev) => {
      const data = new Uint8Array(ev.data)
      console.log('[wsclient] onmessage', data.length, 'bytes, established=', this.session.isEstablished())
      if (!this.session.isEstablished()) {
        // The very first server frame is the handshake reply.
        const res = this.session.finishHandshake(data)
        if (res.ok) {
          this.reconnectMs = RECONNECT_MIN_MS
          this._setState('established', `server v${res.version}`)
        } else {
          this._log(`x handshake rejected: ${res.reason || 'unknown'}`)
          // Stop the reconnect loop for fatal rejections — those are not
          // network blips, retrying won't help.
          const reason = res.reason || ''
          this._setState('rejected', reason)
          if (/cmd=0xff/.test(reason)) this.closedManually = true
          ws.close()
        }
        return
      }
      const msg = this.session.parseIncoming(data)
      // serde-wasm-bindgen sends Vec<u8> as Array<number>; convert to
      // Uint8Array so TextDecoder, RTC bodies etc. accept it directly.
      if (msg.body)    msg.body    = asU8(msg.body)
      if (msg.from_id) msg.from_id = asU8(msg.from_id)
      switch (msg.kind) {
        case 'server':
          this.onServer(msg)
          this._log(`← server cmd=0x${msg.cmd.toString(16).padStart(2,'0')}`)
          break
        case 'peer':
          this.onPeer(msg)
          break
        case 'error':
          this._log(`x parse: ${msg.reason}`)
          break
      }
    }
    ws.onerror = () => {}
    ws.onclose = (ev) => {
      this._setState('closed', `${ev.code} ${ev.reason || ''}`.trim())
      this.ws = null
      if (!this.closedManually) this._scheduleReconnect()
    }
  }

  _scheduleReconnect() {
    this._setState('reconnect-in', `${(this.reconnectMs/1000)|0}s`)
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer)
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null
      if (this.closedManually) return
      this.reconnectMs = Math.min(this.reconnectMs * 2, RECONNECT_MAX_MS)
      this._open()
    }, this.reconnectMs)
  }

  // True only when the socket is open AND the handshake is done.
  isConnected() {
    return !!(this.ws && this.ws.readyState === 1 && this.session && this.session.isEstablished())
  }

  // Reconnect immediately instead of waiting out the backoff — call on app
  // resume / before accepting a call, so a backgrounded socket comes back fast.
  reconnectNow() {
    this.closedManually = false
    if (this.isConnected()) return
    // A connect is already in flight (CONNECTING=0 or OPEN-but-handshaking=1) —
    // let it finish rather than tearing it down.
    if (this.ws && this.ws.readyState <= 1) return
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null }
    this.reconnectMs = RECONNECT_MIN_MS
    this.session ? this._open() : this.connect()
  }

  _setState(s, detail) {
    this.onState({ state: s, detail })
    this._log(`WS: ${s}${detail ? ' (' + detail + ')' : ''}`)
  }

  _log(line) { this.onConsole(line) }

  // ---- identity / peer book ----

  get myId()    { return this.session.myId() }
  get myXPub()  { return this.session.myXPub() }
  get myEdPub() { return this.session.myEdPub() }
  /** Returns the QR text including the given nickname (empty string OK). */
  qrText(nickname) { return this.session.qrText(nickname || '') }

  /** Add a peer from raw key bytes. Returns the new ClientId (Uint8Array(8)). */
  addPeer(xPub, edPub) { return this.session.addPeer(xPub, edPub) }

  /** Add a peer from a QR text payload (the "K0..." string). Returns ClientId. */
  addPeerFromQr(text)  { return this.session.addPeerFromQr(text) }

  removePeer(id) { return this.session.removePeer(id) }

  // ---- outbound ----

  /** Send a text message. Wire payload = [msg_id:16][utf-8 text].
   *  The caller supplies the UUID so the receiver can ACK it and so the
   *  local outbox can match the ACK back to its entry. */
  sendText(peerId, msgIdUuid, text) {
    const u8 = uuidToBytes(msgIdUuid)
    const txt = new TextEncoder().encode(text)
    const body = new Uint8Array(16 + txt.length)
    body.set(u8, 0); body.set(txt, 16)
    return this._sendPeer(peerId, CMD.TEXT, body)
  }

  /** Acknowledge that we received a peer's text message. */
  sendDeliveryAck(peerId, msgIdUuid) {
    return this._sendPeer(peerId, CMD.DELIVERY_ACK, uuidToBytes(msgIdUuid))
  }

  /** Acknowledge that we've read (displayed in an open chat) a peer's message. */
  sendReadAck(peerId, msgIdUuid) {
    return this._sendPeer(peerId, CMD.READ_ACK, uuidToBytes(msgIdUuid))
  }

  /** Send the metadata that announces an upcoming file transfer.
   *  `meta` is a small JSON: { id, name, mime, size, thumb_b64? }. */
  sendFileOffer(peerId, meta) {
    return this._sendPeer(peerId, CMD.FILE_OFFER, new TextEncoder().encode(JSON.stringify(meta)))
  }

  /** Wire = [file_id:16][chunk_idx:u32 LE][bytes]. */
  sendFileChunk(peerId, fileIdUuid, chunkIdx, bytes) {
    const head = new Uint8Array(20)
    head.set(uuidToBytes(fileIdUuid), 0)
    new DataView(head.buffer).setUint32(16, chunkIdx, true)
    const body = new Uint8Array(20 + bytes.length)
    body.set(head, 0); body.set(bytes, 20)
    return this._sendPeer(peerId, CMD.FILE_CHUNK, body)
  }

  /** Wire = [file_id:16][msg_id:16]. Receiver finalises file storage
   *  and records the chat-bubble at this moment. */
  sendFileEnd(peerId, fileIdUuid, msgIdUuid) {
    const body = new Uint8Array(32)
    body.set(uuidToBytes(fileIdUuid), 0)
    body.set(uuidToBytes(msgIdUuid), 16)
    return this._sendPeer(peerId, CMD.FILE_END, body)
  }

  /** Ask the peer to delete a message on their side. Wire = [msg_id:16]. */
  sendMsgDelete(peerId, msgIdUuid) {
    return this._sendPeer(peerId, CMD.MSG_DELETE, uuidToBytes(msgIdUuid))
  }

  /** Ask the peer to replace a message's text. Wire = [msg_id:16][utf-8]. */
  sendMsgEdit(peerId, msgIdUuid, text) {
    const u8 = uuidToBytes(msgIdUuid)
    const txt = new TextEncoder().encode(text)
    const body = new Uint8Array(16 + txt.length)
    body.set(u8, 0); body.set(txt, 16)
    return this._sendPeer(peerId, CMD.MSG_EDIT, body)
  }

  /** Tell a peer to start a numbered sound. */
  sendSoundStart(peerId, soundId) {
    return this._sendPeer(peerId, CMD.SOUND_START, new Uint8Array([soundId & 0xff]))
  }

  /** Tell a peer to stop a numbered sound. */
  sendSoundStop(peerId, soundId) {
    return this._sendPeer(peerId, CMD.SOUND_STOP, new Uint8Array([soundId & 0xff]))
  }

  /** Tell a peer to stop all sounds. */
  sendSoundStopAll(peerId) {
    return this._sendPeer(peerId, CMD.SOUND_STOP_ALL, new Uint8Array(0))
  }

  /** Subscribe to presence updates for a list of peer X-pubs. */
  subscribe(xPubsArray) {
    const body = concatU8(xPubsArray)
    return this._sendServer(CMD.SUBSCRIBE, body)
  }

  /** Cancel presence subscription for a list of peer X-pubs. */
  unsubscribe(xPubsArray) {
    const body = concatU8(xPubsArray)
    return this._sendServer(CMD.UNSUBSCRIBE, body)
  }

  /** Ask the server to send our public keys + nickname to `targetId`.
   *  Used right after we add a peer from their invite link. */
  introduce(targetId, nickname) {
    if (!this.ws || this.ws.readyState !== 1) return false
    const frame = this.session.buildIntroduce(targetId, nickname || '', this._nextMsgId())
    this.ws.send(frame)
    return true
  }

  /** Register a push token with the server so it can wake us when offline.
   *  Wire = [kind:1][token utf-8 bytes]. kind 2 = Web Push; token is the
   *  JSON.stringify(subscription.toJSON()) of a PushSubscription. */
  sendPushRegister(kind, tokenStr) {
    const tok = new TextEncoder().encode(tokenStr)
    const body = new Uint8Array(1 + tok.length)
    body[0] = kind & 0xff
    body.set(tok, 1)
    return this._sendServer(CMD.PUSH_REGISTER, body)
  }

  /** Ask the server to push-wake an offline recipient. Wire =
   *  [target:8][type:1]: target is the first 8 bytes of the recipient's
   *  X25519 public key (their ClientId); type 1 = incoming call (ringtone),
   *  0 = message. */
  sendWake(targetId, isCall = false) {
    const body = new Uint8Array(9)
    body.set(asU8(targetId).slice(0, 8), 0)
    body[8] = isCall ? 1 : 0
    return this._sendServer(CMD.WAKE, body)
  }

  _sendPeer(peerId, cmd, body) {
    if (!this.ws || this.ws.readyState !== 1) return false
    const frame = this.session.buildPeerFrame(peerId, cmd, body, this._nextMsgId())
    this.ws.send(frame)
    return true
  }

  _sendServer(cmd, body) {
    if (!this.ws || this.ws.readyState !== 1) return false
    const frame = this.session.buildServerFrame(cmd, body, this._nextMsgId())
    this.ws.send(frame)
    return true
  }

  _nextMsgId() {
    const id = this.msgIdCounter
    this.msgIdCounter = (this.msgIdCounter + 1) & 0xffff
    return id
  }
}

function asU8(v) {
  return v instanceof Uint8Array ? v : new Uint8Array(v)
}

function uuidToBytes(uuid) {
  const hex = uuid.replace(/-/g, '')
  const out = new Uint8Array(16)
  for (let i = 0; i < 16; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16)
  return out
}

function concatU8(arr) {
  let total = 0
  for (const a of arr) total += a.length
  const out = new Uint8Array(total)
  let off = 0
  for (const a of arr) { out.set(a, off); off += a.length }
  return out
}

export function u8hex(u8) {
  let s = ''
  for (const b of u8) s += b.toString(16).padStart(2, '0')
  return s
}

export function hexU8(hex) {
  const m = hex.match(/.{1,2}/g) || []
  return new Uint8Array(m.map(b => parseInt(b, 16)))
}
