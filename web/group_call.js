// Group (multi-party) calls over a full WebRTC MESH — up to MAX_MEMBERS people,
// no media server, so end-to-end encryption is preserved (media flows P2P /
// through TURN, never through the relay). 1:1 calls are handled by CallManager
// (webrtc.js) and are intentionally left untouched; this is a separate engine.
//
// Signalling reuses the same point-to-point relay as 1:1, with new peer command
// codes (0x38–0x3D) that the relay forwards opaquely (no server change, exactly
// like CALL.MISSED was added). Every group frame carries the room id so stray /
// late frames from another room are ignored.
//
// Mesh formation (glare-free, no central coordinator):
//   * The host picks members and sends GROUP_INVITE (carrying the full roster:
//     each member's id + QR public keys + label) to each invitee. Because the
//     roster includes public keys, you can be in a call with people who are not
//     in your contact book — their keys are registered into the crypto session
//     via addPeerFromQr(), transiently, without touching the contact list.
//   * On accept, an invitee announces GROUP_JOIN to everyone. Any already-active
//     member that hears a *new* member echoes its own GROUP_JOIN back, so the
//     joiner learns the full active set (gossip that converges).
//   * For each pair, the member with the lexicographically smaller id is the
//     offerer. Deterministic on both sides ⇒ no glare, no duplicate peer
//     connections.

import { TURN_SERVERS } from './webrtc.js'

export const GROUP = {
  INVITE: 0x38,  // host → invitee : { room, roster:[{id,qr,label}], host }
  JOIN:   0x39,  // member → member: { room }   (I am active in this room)
  BYE:    0x3A,  // member → member: { room }   (I am leaving)
  OFFER:  0x3B,  // offerer → answerer: { room, sdp }
  ANSWER: 0x3C,  // answerer → offerer: { room, sdp }
  ICE:    0x3D,  // either → other:    { room, cand }
}

export const MAX_MEMBERS = 5

// Group calls default to a modest resolution: mesh means every participant
// uploads their video to every other participant, so bitrate is the scarce
// resource. Users can still toggle video off entirely.
const GROUP_VIDEO_HEIGHT = 360

const enc = (s) => new TextEncoder().encode(s)
const dec = (u) => new TextDecoder().decode(u)

function hexOf(u8) {
  let s = ''
  for (const b of u8) s += b.toString(16).padStart(2, '0')
  return s
}
function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16)
  return out
}
function randomRoom() {
  const u = new Uint8Array(8)
  crypto.getRandomValues(u)
  return hexOf(u)
}

export class GroupCallManager {
  /**
   * @param client WsClient
   * @param ui {
   *   log, onState(state),
   *   onInvite(room, hostLabel, memberLabels[]),  // ask the user to accept
   *   onParticipantJoin(idHex, label),
   *   onParticipantStream(idHex, stream|null),
   *   onParticipantLeave(idHex),
   *   onLocalStream(stream|null),
   *   onScreenShare(bool),
   * }
   */
  constructor(client, ui) {
    this.client = client
    this.ui = ui
    this.room = null
    // idHex -> { id:Uint8Array(8), idHex, qr, label, active, pc, pendingIce[] }
    this.members = new Map()
    this.localStream = null
    this.preferredFacing = 'user'
    this._videoOff = false
    this._lastVideoTrack = null
    this._screenStream = null
    // Pending invite we showed the user but they haven't accepted yet.
    this.pendingInvite = null   // { room, roster, hostHex }
  }

  get myIdHex() { return hexOf(this.client.myId) }
  get active()  { return !!this.room }
  /** Active remote members (everyone but me who has joined). */
  get participantCount() {
    let n = 0
    for (const m of this.members.values()) if (m.active) n++
    return n
  }

  /* --------------------------- public actions --------------------------- */

  /** Start a group call as host. `roster` includes ME and is
   *  [{ id:hex, qr:string, label:string }, …], length ≤ MAX_MEMBERS. */
  async start(roster) {
    if (this.active) { this.ui.log('group: already in a call'); return }
    if (!Array.isArray(roster) || roster.length < 2) { this.ui.log('group: need ≥2'); return }
    roster = roster.slice(0, MAX_MEMBERS)
    this.room = randomRoom()
    this._ingestRoster(roster)
    await this._openMedia()
    this.ui.onState('group:active')
    // Invite every remote member; I (host) am active immediately.
    const body = enc(JSON.stringify({
      room: this.room,
      host: this.myIdHex,
      roster: roster.map(r => ({ id: r.id, qr: r.qr, label: r.label || '' })),
    }))
    for (const m of this.members.values()) {
      if (m.idHex === this.myIdHex) continue
      this.client._sendPeer(m.id, GROUP.INVITE, body)
    }
  }

  /** Accept an invite we previously surfaced via ui.onInvite. */
  async acceptInvite(room) {
    const inv = this.pendingInvite
    this.pendingInvite = null
    if (!inv || inv.room !== room) { this.ui.log('group: stale invite'); return }
    if (this.active) { this.ui.log('group: busy'); return }
    this.room = inv.room
    this._ingestRoster(inv.roster)
    await this._openMedia()
    this.ui.onState('group:active')
    // Announce myself to everyone; the JOIN-echo gossip wires up the mesh.
    this._broadcast(GROUP.JOIN, { room: this.room })
  }

  rejectInvite(room) {
    if (this.pendingInvite && this.pendingInvite.room === room) this.pendingInvite = null
    // No explicit reject frame needed: the host simply never sees us JOIN.
  }

  /** Leave the call: say goodbye to everyone, tear everything down. */
  leave() {
    if (!this.active) return
    this._broadcast(GROUP.BYE, { room: this.room })
    this._teardown('group:ended')
  }

  /* --------------------------- media controls --------------------------- */

  toggleMute() {
    if (!this.localStream) return false
    const a = this.localStream.getAudioTracks()[0]
    if (!a) return false
    a.enabled = !a.enabled
    return !a.enabled
  }

  /** Stop/start sending video to ALL peers. Returns the new "off" state. */
  toggleVideo() {
    if (!this.localStream) return false
    const v = this.localStream.getVideoTracks()[0]
    if (!v && !this._videoOff) return false
    if (this._videoOff) {
      if (this._lastVideoTrack) {
        v && (v.enabled = true)
        this._eachVideoSender(s => s.replaceTrack(this._lastVideoTrack))
      }
      this._videoOff = false
    } else {
      if (v) { v.enabled = false; this._lastVideoTrack = v }
      this._eachVideoSender(s => s.replaceTrack(null))
      this._videoOff = true
    }
    return this._videoOff
  }

  get isScreenSharing() { return !!this._screenStream }

  /** Toggle screen share to all peers (replaceTrack on every video sender). */
  async toggleScreenShare() {
    if (!this.localStream) return false
    if (this._screenStream) { await this._stopScreenShare(); return false }
    let display
    try {
      display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false })
    } catch (e) { this.ui.log(`x getDisplayMedia: ${e}`); return false }
    const screenTrack = display.getVideoTracks()[0]
    if (!screenTrack) return false
    const old = this.localStream.getVideoTracks()[0]
    old?.stop()
    if (old) this.localStream.removeTrack(old)
    this.localStream.addTrack(screenTrack)
    this._eachVideoSender(s => s.replaceTrack(screenTrack))
    this._videoOff = false
    this._screenStream = display
    screenTrack.onended = () => { this._stopScreenShare().catch(() => {}) }
    this.ui.onLocalStream(this.localStream)
    this.ui.onScreenShare?.(true)
    return true
  }

  async _stopScreenShare() {
    if (!this._screenStream) return
    const display = this._screenStream
    this._screenStream = null
    let cam = null
    try {
      const s = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: this.preferredFacing }, height: { ideal: GROUP_VIDEO_HEIGHT } },
        audio: false,
      })
      cam = s.getVideoTracks()[0]
    } catch (e) { this.ui.log(`x restore camera: ${e}`) }
    const screenTrack = this.localStream?.getVideoTracks()[0]
    screenTrack?.stop()
    if (screenTrack && this.localStream) this.localStream.removeTrack(screenTrack)
    display.getTracks().forEach(t => t.stop())
    if (this.localStream && cam) this.localStream.addTrack(cam)
    this._eachVideoSender(s => s.replaceTrack(cam ?? null))
    this.ui.onLocalStream(this.localStream)
    this.ui.onScreenShare?.(false)
  }

  /* --------------------------- message dispatch -------------------------- */

  /** Called by the shared onPeer dispatcher for cmds 0x38–0x3D. */
  async _onPeerMessage(msg) {
    const fromHex = hexOf(msg.from_id)
    let payload
    try { payload = JSON.parse(dec(msg.body)) } catch { return }

    if (msg.cmd === GROUP.INVITE) { this._onInvite(fromHex, payload); return }

    // Everything else is only meaningful inside our current room.
    if (!this.active || !payload || payload.room !== this.room) return
    const m = this.members.get(fromHex)
    if (!m) return  // not part of this room's roster

    switch (msg.cmd) {
      case GROUP.JOIN:   await this._onJoin(m); break
      case GROUP.BYE:    this._onBye(m); break
      case GROUP.OFFER:  await this._onOffer(m, payload.sdp); break
      case GROUP.ANSWER: await this._onAnswer(m, payload.sdp); break
      case GROUP.ICE:    await this._onIce(m, payload.cand); break
    }
  }

  _onInvite(fromHex, payload) {
    if (this.active) return            // already in a call — ignore (busy)
    if (this.pendingInvite) return     // one invite at a time
    if (!payload || !payload.room || !Array.isArray(payload.roster)) return
    if (payload.roster.length > MAX_MEMBERS) return
    this.pendingInvite = { room: payload.room, roster: payload.roster, hostHex: fromHex }
    const hostEntry = payload.roster.find(r => r.id === fromHex)
    const hostLabel = hostEntry?.label || fromHex.slice(0, 8)
    const memberLabels = payload.roster
      .filter(r => r.id !== fromHex && r.id !== this.myIdHex)
      .map(r => r.label || r.id.slice(0, 8))
    this.ui.onInvite(payload.room, hostLabel, memberLabels)
  }

  async _onJoin(m) {
    if (m.active) return               // already known — don't echo again
    m.active = true
    this.ui.onParticipantJoin(m.idHex, m.label)
    // Echo my presence so the new member learns I'm active too.
    this.client._sendPeer(m.id, GROUP.JOIN, enc(JSON.stringify({ room: this.room })))
    // Glare rule: lower id offers.
    if (this.myIdHex < m.idHex) await this._connectTo(m)
  }

  _onBye(m) {
    this._closePeer(m)
    m.active = false
    this.ui.onParticipantLeave(m.idHex)
    // If nobody is left, end the call.
    if (this.participantCount === 0) this._teardown('group:ended')
  }

  async _onOffer(m, sdp) {
    // Expected when the remote is the designated offerer (their id < mine).
    if (!m.pc) this._makePeer(m)
    try {
      await m.pc.setRemoteDescription({ type: 'offer', sdp })
    } catch (e) { this.ui.log(`group offer: ${e}`); return }
    await this._drainIce(m)
    const answer = await m.pc.createAnswer()
    await m.pc.setLocalDescription(answer)
    this._sendTo(m, GROUP.ANSWER, { room: this.room, sdp: answer.sdp })
    if (!m.active) { m.active = true; this.ui.onParticipantJoin(m.idHex, m.label) }
  }

  async _onAnswer(m, sdp) {
    if (!m.pc || m.pc.signalingState !== 'have-local-offer') return
    try { await m.pc.setRemoteDescription({ type: 'answer', sdp }) }
    catch (e) { this.ui.log(`group answer: ${e}`); return }
    await this._drainIce(m)
  }

  async _onIce(m, cand) {
    if (!cand || !cand.candidate) return
    if (m.pc && m.pc.remoteDescription) {
      try { await m.pc.addIceCandidate(cand) } catch (e) { this.ui.log(`group ice: ${e}`) }
    } else {
      m.pendingIce.push(cand)
    }
  }

  /* ----------------------------- mesh plumbing -------------------------- */

  async _connectTo(m) {
    if (m.pc) return
    this._makePeer(m)
    for (const t of this.localStream.getTracks()) m.pc.addTrack(t, this.localStream)
    const offer = await m.pc.createOffer()
    await m.pc.setLocalDescription(offer)
    this._sendTo(m, GROUP.OFFER, { room: this.room, sdp: offer.sdp })
  }

  _makePeer(m) {
    const pc = new RTCPeerConnection({ iceServers: TURN_SERVERS })
    m.pc = pc
    // Make sure our media is attached (offer side adds in _connectTo; answer
    // side adds here so the answer carries our tracks too).
    if (this.localStream) {
      const haveSenders = pc.getSenders().some(s => s.track)
      if (!haveSenders) for (const t of this.localStream.getTracks()) pc.addTrack(t, this.localStream)
    }
    pc.onicecandidate = (e) => {
      if (e.candidate) this._sendTo(m, GROUP.ICE, { room: this.room, cand: e.candidate })
    }
    pc.ontrack = (e) => { this.ui.onParticipantStream(m.idHex, e.streams[0]) }
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        // Leave the tile; a failed leg doesn't kill the whole call.
        this.ui.onParticipantStream(m.idHex, null)
      }
    }
  }

  async _drainIce(m) {
    if (!m.pendingIce.length) return
    for (const c of m.pendingIce) {
      try { await m.pc.addIceCandidate(c) } catch (e) { this.ui.log(`group ice drain: ${e}`) }
    }
    m.pendingIce = []
  }

  _closePeer(m) {
    // Only close the connection — do NOT stop tracks here: the local audio/video
    // tracks are shared across every peer's RTCPeerConnection. They're stopped
    // once in _teardown(). Remote tracks die with the pc.
    try { m.pc?.close() } catch {}
    m.pc = null
    m.pendingIce = []
  }

  /* ------------------------------- helpers ------------------------------ */

  /** Register every roster member's keys and seed the members map. Members are
   *  identified by the ClientId derived from their QR (authoritative); self is
   *  skipped for key registration. */
  _ingestRoster(roster) {
    for (const r of roster) {
      const idHex = r.id
      if (idHex === this.myIdHex) {
        if (!this.members.has(idHex)) {
          this.members.set(idHex, { id: this.client.myId, idHex, qr: r.qr, label: r.label || '', active: true, pc: null, pendingIce: [] })
        }
        continue
      }
      let id
      try { id = this.client.addPeerFromQr(r.qr) }       // registers keys, returns ClientId
      catch (e) { this.ui.log(`group roster ${idHex}: ${e}`); id = hexToBytes(idHex) }
      const realHex = hexOf(id)
      if (!this.members.has(realHex)) {
        this.members.set(realHex, { id, idHex: realHex, qr: r.qr, label: r.label || '', active: false, pc: null, pendingIce: [] })
      }
    }
  }

  async _openMedia() {
    if (this.localStream) return
    try {
      this.localStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: this.preferredFacing }, height: { ideal: GROUP_VIDEO_HEIGHT } },
        audio: true,
      })
      this.ui.onLocalStream(this.localStream)
    } catch (e) { this.ui.log(`x getUserMedia: ${e}`); throw e }
  }

  _sendTo(m, cmd, obj) { this.client._sendPeer(m.id, cmd, enc(JSON.stringify(obj))) }

  _broadcast(cmd, obj) {
    const body = enc(JSON.stringify(obj))
    for (const m of this.members.values()) {
      if (m.idHex === this.myIdHex) continue
      this.client._sendPeer(m.id, cmd, body)
    }
  }

  _eachVideoSender(fn) {
    for (const m of this.members.values()) {
      if (!m.pc) continue
      const sender = m.pc.getSenders().find(s => s.track && s.track.kind === 'video')
                  ?? m.pc.getSenders().find(s => s.track === null)
      if (sender) fn(sender)
    }
  }

  _teardown(state) {
    for (const m of this.members.values()) {
      this._closePeer(m)
      if (m.idHex !== this.myIdHex && m.active) this.ui.onParticipantLeave(m.idHex)
    }
    if (this._screenStream) { this._screenStream.getTracks().forEach(t => t.stop()); this._screenStream = null }
    this.localStream?.getTracks().forEach(t => t.stop())
    this.localStream = null
    this.members.clear()
    this.room = null
    this._videoOff = false
    this._lastVideoTrack = null
    this.ui.onLocalStream(null)
    this.ui.onScreenShare?.(false)
    this.ui.onState(state || 'group:ended')
  }
}
