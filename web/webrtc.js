// WebRTC wrapper. Signalling goes through the WsClient using these cmd
// codes (defined in PROTOCOL.md for ws.lleo.me v2):
//
//   0x30 CALL_REQUEST     (initiator → callee, body: empty)
//   0x31 CALL_ACCEPT      (callee → initiator)
//   0x32 CALL_REJECT
//   0x33 CALL_HANGUP
//   0x34 SDP_OFFER        body: utf-8 SDP string
//   0x35 SDP_ANSWER       body: utf-8 SDP string
//   0x36 ICE_CANDIDATE    body: utf-8 JSON candidate
//   0x37 CALL_MISSED      (initiator → callee, body: empty) — sent when a placed
//                          call ends unanswered (rang out / cancelled while
//                          ringing), so the callee learns they missed it. Peer
//                          cmds 0x10–0x3F are opaque to the relay (forwarded
//                          as-is), so this needs no server change.
//
// One active call at a time. The UI is responsible for offering the
// "incoming call" prompt and binding the right buttons.

export const CALL = {
  REQUEST:        0x30,
  ACCEPT:         0x31,
  REJECT:         0x32,
  HANGUP:         0x33,
  SDP_OFFER:      0x34,
  SDP_ANSWER:     0x35,
  ICE_CANDIDATE:  0x36,
  MISSED:         0x37,
}

// Outside of the CallManager — app.js wires these up separately, but we
// keep the constant next to the others for protocol-doc convenience.
export const TEXT_CMD         = 0x20
export const DELIVERY_ACK_CMD = 0x27
export const FILE_OFFER_CMD   = 0x24
export const FILE_CHUNK_CMD   = 0x25
export const FILE_END_CMD     = 0x26
export const MSG_DELETE_CMD   = 0x28
export const MSG_EDIT_CMD     = 0x29
export const READ_ACK_CMD     = 0x2A

// Single, locally-operated STUN + TURN inside the project's infra.
const TURN_SERVERS = [
  { urls: 'stun:telefon.lleo.me:3478' },
  {
    urls: [
      'turn:telefon.lleo.me:3478?transport=udp',
      'turn:telefon.lleo.me:3478?transport=tcp',
    ],
    username:   '68ac1de52dedfab6',
    credential: 'iHBRacAQfp1yUG6AILAxg6eOIGQejAiy',
  },
]

const enc = (s) => new TextEncoder().encode(s)
const dec = (u) => new TextDecoder().decode(u)

// How long the caller keeps a placed call "ringing" while waiting for the
// callee to wake up / answer. After this it's torn down as "no answer".
const RING_TIMEOUT_MS = 40000

// Lower-case hex of a byte array (local copy so webrtc.js stays standalone;
// matches u8hex in ws_client.js).
function hexOf(u8) {
  let s = ''
  for (const b of u8) s += b.toString(16).padStart(2, '0')
  return s
}

// Inverse of hexOf for fixed-length id hex (e.g. an 8-byte ClientId). Used to
// rebuild a peer id from the hex we cached in _owedMissed when re-sending.
function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16)
  return out
}

// 16-byte raw UUID ↔ canonical 8-4-4-4-12 hex string.
function uuidToBytes(uuid) {
  const hex = uuid.replace(/-/g, '')
  const out = new Uint8Array(16)
  for (let i = 0; i < 16; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16)
  return out
}
function uuidFromBytes(u8) {
  let s = ''
  for (let i = 0; i < 16; i++) s += u8[i].toString(16).padStart(2, '0')
  return `${s.slice(0,8)}-${s.slice(8,12)}-${s.slice(12,16)}-${s.slice(16,20)}-${s.slice(20)}`
}

export class CallManager {
  constructor(client, ui) {
    this.client = client       // WsClient instance
    this.ui     = ui           // { onState, onIncomingCall, onText, log }
    this.pc     = null
    this.peerId = null         // Uint8Array(8) — currently active peer
    this.pendingCandidates = []
    this.localStream = null
    this.preferredFacing = 'user'  // 'user' or 'environment'
    // Outgoing-call "ringing" state. While set, the caller is waiting for the
    // callee to accept; if the callee was offline (asleep) the initial
    // CALL.REQUEST was dropped, so we re-send it the moment their presence
    // flips online (see onPeerOnline). { peerId: Uint8Array(8), since: ms }.
    this.ringing      = null
    this._ringTimer   = null
    // Callees we owe a "missed call" notice. A placed call that ends while still
    // ringing (rang out / cancelled before accept) means the callee never got a
    // live ring — we try to deliver CALL.MISSED right away, and if that peer was
    // offline we keep their hex id here and re-send when they come back online
    // (onPeerOnline). Set of lower-case hex ids.
    this._owedMissed  = new Set()
  }

  /** Wire this manager to a WsClient — dispatch its peer messages here. */
  attach() {
    this.client.onPeer = (msg) => this._onPeerMessage(msg)
  }

  /* ------------------- public actions ------------------- */

  async call(peerId) {
    this.peerId = peerId
    this.ui.onState('calling')
    // Start ringing: hold the call open so we can re-send CALL.REQUEST if the
    // callee was offline and only comes online after the call push wakes them.
    this.ringing = { peerId, since: Date.now() }
    if (this._ringTimer) clearTimeout(this._ringTimer)
    this._ringTimer = setTimeout(() => {
      // Still ringing after the timeout → no answer. Tear down the call.
      if (!this.ringing) return
      this.ui.log('no answer')
      this._markMissed(this.ringing.peerId)  // capture callee before _clearRing nulls it
      this.hangup()                 // _clearRing + _tearDown('hangup') inside
    }, RING_TIMEOUT_MS)
    this.client._sendPeer(peerId, CALL.REQUEST, new Uint8Array())
    // Open the camera right away (after sending the ring so it isn't delayed by
    // the permission prompt) so the caller sees their own self-view while
    // waiting for an answer — time to fix their hair. _openMedia is idempotent,
    // so the same stream is reused when the SDP offer is crafted on ACCEPT.
    try { await this._openMedia() } catch (e) { this.ui.log('preview media: ' + e) }
  }

  /** Stop ringing: clear the held-call state and its timeout. Idempotent. */
  _clearRing() {
    this.ringing = null
    if (this._ringTimer) { clearTimeout(this._ringTimer); this._ringTimer = null }
  }

  /** A placed call to `peerId` (Uint8Array(8)) ended unanswered. Remember the
   *  callee as owed a missed-call notice and try to deliver CALL.MISSED now; if
   *  they're offline the send is dropped by the relay and we re-send the moment
   *  their presence flips online (onPeerOnline). Never throws. */
  _markMissed(peerId) {
    if (!peerId) return
    const idHex = hexOf(peerId)
    this._owedMissed.add(idHex)
    try { this.client._sendPeer(peerId, CALL.MISSED, new Uint8Array()) }
    catch (e) { this.ui.log('missed-notice: ' + e) }
  }

  /** Presence flipped online for `idHex`. If a call to that exact peer is still
   *  ringing within the ring window, re-send CALL.REQUEST — they're online now
   *  (woken by the call push), so no WAKE is needed. ADDITIONALLY, if we owe
   *  this peer a missed-call notice (they were offline when their call rang out),
   *  deliver CALL.MISSED now that they're reachable. Never throws; no-op when
   *  not ringing, ringing for someone else, or already past the window. */
  onPeerOnline(idHex) {
    const r = this.ringing
    if (r && r.peerId && Date.now() - r.since <= RING_TIMEOUT_MS && hexOf(r.peerId) === idHex) {
      try { this.client._sendPeer(r.peerId, CALL.REQUEST, new Uint8Array()) }
      catch (e) { this.ui.log('re-ring: ' + e) }
      return  // actively ringing them — don't also fire a missed notice
    }
    if (this._owedMissed.has(idHex)) {
      this._owedMissed.delete(idHex)
      try { this.client._sendPeer(hexToBytes(idHex), CALL.MISSED, new Uint8Array()) }
      catch (e) { this.ui.log('missed-notice (online): ' + e) }
    }
  }

  hangup() {
    // If the call is still ringing (never accepted) when it's torn down, the
    // callee never got a live ring → owe them a missed-call notice. Capture the
    // ringing peer before _clearRing nulls it. A call that was already accepted
    // cleared `ringing` on CALL.ACCEPT, so this won't fire for answered calls.
    const wasRinging = this.ringing ? this.ringing.peerId : null
    this._clearRing()
    if (wasRinging) this._markMissed(wasRinging)
    if (this.peerId) {
      this.client._sendPeer(this.peerId, CALL.HANGUP, new Uint8Array())
    }
    this._tearDown('hangup')
  }

  async acceptIncoming(peerId) {
    this.peerId = peerId
    this.client._sendPeer(peerId, CALL.ACCEPT, new Uint8Array())
    // Initiator side: when they get ACCEPT, they will craft an offer; we
    // wait for SDP_OFFER. We do nothing here other than open the camera.
    await this._openMedia()
  }

  rejectIncoming(peerId) {
    this.client._sendPeer(peerId, CALL.REJECT, new Uint8Array())
  }

  /** Mute / unmute the local video. Returns the new "off" state.
   *  We do TWO things: flip `track.enabled` (so getUserMedia stops
   *  rendering the local preview frames), AND replace the sender's
   *  track with null. The latter is what actually shuts the encoder
   *  down so the bitrate drops to zero on the wire — `enabled=false`
   *  alone keeps Chrome's encoder happily emitting black frames. */
  toggleVideo() {
    if (!this.localStream) return false
    const v = this.localStream.getVideoTracks()[0]
    if (!v) return false
    const sender = this.pc?.getSenders().find(s => s.track && s.track.kind === 'video')
                ?? this.pc?.getSenders().find(s => s.track === null && this._lastVideoTrack)
    if (this._videoOff) {
      // turning back on
      v.enabled = true
      if (sender && this._lastVideoTrack) sender.replaceTrack(this._lastVideoTrack)
      this._videoOff = false
    } else {
      // turning off — keep a reference so we can re-attach later
      v.enabled = false
      this._lastVideoTrack = v
      if (sender) sender.replaceTrack(null)
      this._videoOff = true
    }
    return this._videoOff
  }

  /** Apply a new resolution constraint to the active video track without
   *  renegotiating the SDP. Returns true if the browser accepted it. */
  async setVideoResolution(height) {
    if (!this.localStream) return false
    const v = this.localStream.getVideoTracks()[0]
    if (!v) return false
    this.preferredHeight = height
    try {
      await v.applyConstraints({ height: { ideal: height } })
      return true
    } catch (e) {
      this.ui.log(`x setVideoResolution: ${e}`); return false
    }
  }

  /** Route the remote audio to a specific output device. `deviceId` comes
   *  from enumerateDevices() audiooutput entries; '' selects the default.
   *  Not all browsers expose setSinkId on <video>; on iOS Safari it's a
   *  no-op. Caller should swallow errors gracefully. */
  async setAudioSink(deviceId) {
    const v = document.getElementById('peer-video')
    if (!v || typeof v.setSinkId !== 'function') {
      throw new Error('setSinkId not supported in this browser')
    }
    await v.setSinkId(deviceId)
  }

  /** Enumerate available capture devices. Labels are only populated once a
   *  permission grant / getUserMedia has happened — by the time a call is
   *  active that's always true, so the picker shows readable names. */
  async listDevices() {
    let devs = []
    try { devs = await navigator.mediaDevices.enumerateDevices() }
    catch (e) { this.ui.log(`x enumerateDevices: ${e}`); return { audioInputs: [], videoInputs: [] } }
    const audioInputs = devs.filter(d => d.kind === 'audioinput')
                            .map(d => ({ deviceId: d.deviceId, label: d.label }))
    const videoInputs = devs.filter(d => d.kind === 'videoinput')
                            .map(d => ({ deviceId: d.deviceId, label: d.label }))
    return { audioInputs, videoInputs }
  }

  /** Switch to a specific camera by deviceId. Replaces the video track in
   *  the existing RTCPeerConnection so the call is not interrupted. */
  async setVideoInput(deviceId) {
    if (!this.localStream) return
    const old = this.localStream.getVideoTracks()[0]
    let next = null
    try {
      const s = await navigator.mediaDevices.getUserMedia({
        video: { deviceId: { exact: deviceId } },
        audio: false,
      })
      next = s.getVideoTracks()[0]
    } catch (e) {
      this.ui.log(`x setVideoInput: ${e}`); return
    }
    old?.stop()
    if (old) this.localStream.removeTrack(old)
    this.localStream.addTrack(next)
    if (this.pc) {
      const sender = this.pc.getSenders().find(s => s.track && s.track.kind === 'video')
      if (sender) await sender.replaceTrack(next)
    }
    this.ui.onLocalStream(this.localStream)
  }

  /** Switch to a specific microphone by deviceId. Replaces the audio track
   *  in the existing RTCPeerConnection so the call is not interrupted. */
  async setAudioInput(deviceId) {
    if (!this.localStream) return
    const old = this.localStream.getAudioTracks()[0]
    let next = null
    try {
      const s = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: { exact: deviceId } },
        video: false,
      })
      next = s.getAudioTracks()[0]
    } catch (e) {
      this.ui.log(`x setAudioInput: ${e}`); return
    }
    old?.stop()
    if (old) this.localStream.removeTrack(old)
    this.localStream.addTrack(next)
    if (this.pc) {
      const sender = this.pc.getSenders().find(s => s.track && s.track.kind === 'audio')
      if (sender) await sender.replaceTrack(next)
    }
  }

  /** Toggle between front and back camera. Replaces the video track in
   *  the existing RTCPeerConnection so the call is not interrupted. */
  async switchCamera() {
    this.preferredFacing = this.preferredFacing === 'user' ? 'environment' : 'user'
    if (!this.localStream) return
    const old = this.localStream.getVideoTracks()[0]
    let next = null
    try {
      const s = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: this.preferredFacing } },
        audio: false,
      })
      next = s.getVideoTracks()[0]
    } catch (e) {
      this.ui.log(`x switchCamera: ${e}`); return
    }
    old?.stop()
    this.localStream.removeTrack(old)
    this.localStream.addTrack(next)
    if (this.pc) {
      const sender = this.pc.getSenders().find(s => s.track && s.track.kind === 'video')
      if (sender) await sender.replaceTrack(next)
    }
    this.ui.onLocalStream(this.localStream)
  }

  /**
   * Snapshot the active ICE candidate pair and a few transport metrics.
   * Returns null when no call is active or stats are not yet available.
   *
   *   { local:    'host' | 'srflx' | 'prflx' | 'relay',
   *     remote:   same,
   *     protocol: 'udp' | 'tcp',
   *     rttMs:    number,
   *     bytesSent, bytesReceived,
   *     codec:    { video, audio },
   *     kbpsSent, kbpsReceived }
   */
  async getStats() {
    if (!this.pc) return null
    const report = await this.pc.getStats()
    let pair = null, localId = null, remoteId = null
    const candidates = new Map()
    const codecs = new Map()
    const inboundRtp = []
    const outboundRtp = []
    const remoteInboundRtp = []
    for (const s of report.values()) {
      if (s.type === 'candidate-pair' && (s.selected || s.nominated) && s.state === 'succeeded') {
        pair = s; localId = s.localCandidateId; remoteId = s.remoteCandidateId
      } else if (s.type === 'local-candidate' || s.type === 'remote-candidate') {
        candidates.set(s.id, s)
      } else if (s.type === 'codec') {
        codecs.set(s.id, s)
      } else if (s.type === 'inbound-rtp') {
        inboundRtp.push(s)
      } else if (s.type === 'outbound-rtp') {
        outboundRtp.push(s)
      } else if (s.type === 'remote-inbound-rtp') {
        remoteInboundRtp.push(s)
      }
    }
    if (!pair) {
      for (const s of report.values()) {
        if (s.type === 'candidate-pair' && s.state === 'succeeded') {
          pair = s; localId = s.localCandidateId; remoteId = s.remoteCandidateId; break
        }
      }
    }
    if (!pair) return null
    const local  = candidates.get(localId)
    const remote = candidates.get(remoteId)
    // Byte counters — Firefox doesn't always fill the candidate-pair
    // counters, and when we replaceTrack(null) it may drop the
    // corresponding outbound-rtp entry from the global getStats() report
    // entirely. Walk senders/receivers explicitly and ask each one for
    // its own stats; this is what actually survives across both browsers.
    let sumOut = 0, sumIn = 0
    for (const s of this.pc.getSenders()) {
      if (!s.track) continue
      try {
        const r = await s.getStats()
        r.forEach(stat => { if (stat.type === 'outbound-rtp') sumOut += (stat.bytesSent || 0) })
      } catch {}
    }
    for (const r of this.pc.getReceivers()) {
      if (!r.track) continue
      try {
        const rep = await r.getStats()
        rep.forEach(stat => { if (stat.type === 'inbound-rtp') sumIn += (stat.bytesReceived || 0) })
      } catch {}
    }
    const pairSent = pair.bytesSent     || 0
    const pairRecv = pair.bytesReceived || 0
    const sent = Math.max(sumOut, pairSent)
    const recv = Math.max(sumIn,  pairRecv)
    const now = performance.now()
    let kbpsSent = 0, kbpsRecv = 0
    if (this._lastStats) {
      const dt = (now - this._lastStats.t) / 1000
      if (dt > 0) {
        kbpsSent = ((sent - this._lastStats.sent) * 8 / dt) / 1000
        kbpsRecv = ((recv - this._lastStats.recv) * 8 / dt) / 1000
      }
    }
    this._lastStats = { t: now, sent, recv }
    const codecOf = (rtpStats) => {
      for (const r of rtpStats) {
        const c = codecs.get(r.codecId)
        if (c?.mimeType) return c.mimeType.split('/')[1]
      }
      return '?'
    }
    // RTT: candidate-pair if present (Chrome), else look at the
    // remote-inbound-rtp entry for the audio stream (Firefox).
    let rttSec = pair.currentRoundTripTime ?? 0
    if (!rttSec) {
      for (const r of remoteInboundRtp) {
        if (r.roundTripTime) { rttSec = r.roundTripTime; break }
      }
    }
    return {
      local:    local?.candidateType  || '?',
      remote:   remote?.candidateType || '?',
      protocol: (local?.protocol || '?').toLowerCase(),
      rttMs:    Math.round(rttSec * 1000),
      bytesSent: sent,
      bytesReceived: recv,
      kbpsSent:     Math.round(kbpsSent),
      kbpsReceived: Math.round(kbpsRecv),
      codecVideo:   codecOf(outboundRtp.filter(r => r.kind === 'video').concat(inboundRtp.filter(r => r.kind === 'video'))),
      codecAudio:   codecOf(outboundRtp.filter(r => r.kind === 'audio').concat(inboundRtp.filter(r => r.kind === 'audio'))),
    }
  }

  /** Mute / unmute local microphone. Returns the new muted state. */
  toggleMute() {
    if (!this.localStream) return false
    const a = this.localStream.getAudioTracks()[0]
    if (!a) return false
    a.enabled = !a.enabled
    return !a.enabled
  }

  /* ------------------- message dispatch ------------------- */

  async _onPeerMessage(msg) {
    const cmd = msg.cmd
    const peerId = msg.from_id

    // Plain text — let the UI handle it independently of call state.
    // Wire format: [msg_id : 16 bytes UUID][utf-8 text]
    if (cmd === TEXT_CMD) {
      if (msg.body.length < 16) return
      const msgId = uuidFromBytes(msg.body.slice(0, 16))
      const text  = dec(msg.body.slice(16))
      this.ui.onText(peerId, msgId, text)
      return
    }

    // Acknowledgement that one of our out-messages reached the peer.
    if (cmd === DELIVERY_ACK_CMD) {
      if (msg.body.length < 16) return
      const msgId = uuidFromBytes(msg.body.slice(0, 16))
      this.ui.onDelivered(peerId, msgId)
      return
    }

    // Acknowledgement that the peer has read one of our out-messages.
    if (cmd === READ_ACK_CMD) {
      if (msg.body.length < 16) return
      const msgId = uuidFromBytes(msg.body.slice(0, 16))
      this.ui.onRead?.(peerId, msgId)
      return
    }

    // Peer asks us to delete a message they previously sent us.
    if (cmd === MSG_DELETE_CMD) {
      if (msg.body.length < 16) return
      const msgId = uuidFromBytes(msg.body.slice(0, 16))
      this.ui.onMsgDelete?.(peerId, msgId)
      return
    }

    // Peer asks us to replace the text of a message they sent us.
    // Wire format: [msg_id : 16][utf-8 new text]
    if (cmd === MSG_EDIT_CMD) {
      if (msg.body.length < 16) return
      const msgId = uuidFromBytes(msg.body.slice(0, 16))
      const text  = dec(msg.body.slice(16))
      this.ui.onMsgEdit?.(peerId, msgId, text)
      return
    }

    // ---- file transfer ----

    if (cmd === FILE_OFFER_CMD) {
      let meta
      try { meta = JSON.parse(dec(msg.body)) } catch { return }
      this.ui.onFileOffer(peerId, meta)
      return
    }
    if (cmd === FILE_CHUNK_CMD) {
      if (msg.body.length < 20) return
      const fileId = uuidFromBytes(msg.body.slice(0, 16))
      const idx    = new DataView(msg.body.buffer, msg.body.byteOffset, 20).getUint32(16, true)
      const data   = msg.body.slice(20)
      this.ui.onFileChunk(peerId, fileId, idx, data)
      return
    }
    if (cmd === FILE_END_CMD) {
      if (msg.body.length < 32) return
      const fileId = uuidFromBytes(msg.body.slice(0, 16))
      const msgId  = uuidFromBytes(msg.body.slice(16, 32))
      this.ui.onFileEnd(peerId, fileId, msgId)
      return
    }

    // A call we missed: the caller placed it, it rang out (or they cancelled)
    // before we picked up, and they're telling us after the fact. Not a live
    // call — just notify the UI (log + toast + contact badge).
    if (cmd === CALL.MISSED) {
      this.ui.onMissedCall?.(peerId)
      return
    }

    if (cmd === CALL.REQUEST) {
      this.ui.onIncomingCall(peerId)
      return
    }

    if (cmd === CALL.ACCEPT) {
      // We were the initiator and the other side just OK'd it. Stop ringing
      // (the call is answered) and build the SDP offer now.
      this._clearRing()
      await this._initiate(peerId)
      return
    }

    if (cmd === CALL.REJECT) {
      this.ui.log('peer rejected the call')
      this._clearRing()
      this._tearDown('rejected')
      return
    }

    if (cmd === CALL.HANGUP) {
      this.ui.log('peer hung up')
      this._tearDown('peer hangup')
      return
    }

    if (cmd === CALL.SDP_OFFER) {
      await this._onOffer(peerId, dec(msg.body))
      return
    }

    if (cmd === CALL.SDP_ANSWER) {
      await this._onAnswer(dec(msg.body))
      return
    }

    if (cmd === CALL.ICE_CANDIDATE) {
      await this._onCandidate(dec(msg.body))
      return
    }
  }

  /* ------------------- RTC plumbing ------------------- */

  async _initiate(peerId) {
    this.peerId = peerId
    await this._openMedia()
    this._makePeerConnection()
    for (const t of this.localStream.getTracks()) this.pc.addTrack(t, this.localStream)
    const offer = await this.pc.createOffer()
    await this.pc.setLocalDescription(offer)
    this.client._sendPeer(peerId, CALL.SDP_OFFER, enc(offer.sdp))
    this.ui.onState('connecting')
  }

  async _onOffer(peerId, sdp) {
    this.peerId = peerId
    if (!this.localStream) await this._openMedia()
    this._makePeerConnection()
    for (const t of this.localStream.getTracks()) this.pc.addTrack(t, this.localStream)
    await this.pc.setRemoteDescription({ type: 'offer', sdp })
    for (const c of this.pendingCandidates) {
      try { await this.pc.addIceCandidate(c) } catch (e) { this.ui.log('ice apply: ' + e) }
    }
    this.pendingCandidates = []
    const answer = await this.pc.createAnswer()
    await this.pc.setLocalDescription(answer)
    this.client._sendPeer(peerId, CALL.SDP_ANSWER, enc(answer.sdp))
    this.ui.onState('connecting')
  }

  async _onAnswer(sdp) {
    if (!this.pc) return
    // An answer is only valid right after we sent an offer. Duplicate or late
    // answers (relay re-delivery, reconnect replay) arrive when we're already
    // 'stable' — applying one then throws InvalidStateError. Ignore those.
    if (this.pc.signalingState !== 'have-local-offer') {
      this.ui.log('stray answer ignored (state: ' + this.pc.signalingState + ')')
      return
    }
    try {
      await this.pc.setRemoteDescription({ type: 'answer', sdp })
    } catch (e) {
      this.ui.log('setRemoteDescription(answer) failed: ' + e)
      return
    }
    for (const c of this.pendingCandidates) {
      try { await this.pc.addIceCandidate(c) } catch (e) { this.ui.log('ice apply: ' + e) }
    }
    this.pendingCandidates = []
  }

  async _onCandidate(jsonStr) {
    let cand
    try { cand = JSON.parse(jsonStr) } catch { return }
    if (!cand || !cand.candidate) return
    if (this.pc && this.pc.remoteDescription) {
      try { await this.pc.addIceCandidate(cand) } catch (e) { this.ui.log('ice: ' + e) }
    } else {
      this.pendingCandidates.push(cand)
    }
  }

  async _openMedia() {
    if (this.localStream) return
    try {
      this.localStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: this.preferredFacing } },
        audio: true,
      })
      this.ui.onLocalStream(this.localStream)
    } catch (e) {
      this.ui.log(`x getUserMedia: ${e}`)
      throw e
    }
  }

  _makePeerConnection() {
    this.pc = new RTCPeerConnection({ iceServers: TURN_SERVERS })
    this.pc.onicecandidate = (e) => {
      if (e.candidate && this.peerId) {
        this.client._sendPeer(this.peerId, CALL.ICE_CANDIDATE, enc(JSON.stringify(e.candidate)))
      }
    }
    this.pc.ontrack = (e) => {
      this.ui.onRemoteStream(e.streams[0])
    }
    this.pc.onconnectionstatechange = () => {
      this.ui.onState(this.pc.connectionState)
    }
  }

  _tearDown(reason) {
    this._clearRing()           // catch-all: never leave a ring timer dangling
    try {
      this.pc?.getSenders().forEach(s => s.track?.stop())
      this.pc?.close()
    } catch {}
    this.pc = null
    this.localStream?.getTracks().forEach(t => t.stop())
    this.localStream = null
    this.peerId = null
    this.pendingCandidates = []
    this.ui.onLocalStream(null)
    this.ui.onRemoteStream(null)
    this.ui.onState(reason || 'idle')
  }
}
