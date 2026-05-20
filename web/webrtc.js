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
  }

  /** Wire this manager to a WsClient — dispatch its peer messages here. */
  attach() {
    this.client.onPeer = (msg) => this._onPeerMessage(msg)
  }

  /* ------------------- public actions ------------------- */

  async call(peerId) {
    this.peerId = peerId
    this.ui.onState('calling')
    this.client._sendPeer(peerId, CALL.REQUEST, new Uint8Array())
  }

  hangup() {
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

    if (cmd === CALL.REQUEST) {
      this.ui.onIncomingCall(peerId)
      return
    }

    if (cmd === CALL.ACCEPT) {
      // We were the initiator and the other side just OK'd it.
      // Build the SDP offer now.
      await this._initiate(peerId)
      return
    }

    if (cmd === CALL.REJECT) {
      this.ui.log('peer rejected the call')
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
    await this.pc.setRemoteDescription({ type: 'answer', sdp })
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
