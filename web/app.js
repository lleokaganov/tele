// Entry-point. Two-screen messenger-style UI.

import { WsClient, CMD, u8hex }                                  from './ws_client.js'
import { CallManager }                                            from './webrtc.js'
import { loadSeeds, saveSeeds, generateSeeds, wipeSeeds,
         loadPeers, savePeers,
         loadNickname, saveNickname, wipeNickname }               from './keystore.js'
import { buildInviteUrl, readInviteFromUrl, clearInviteFromUrl }  from './invite.js'
import { Storage, isFileRef, fileIdOf }                           from './storage.js'

// Watchdog: if IndexedDB init never settles in the WebView, surface it
// rather than hanging silently before any UI is wired up.
const _storageWatch = setTimeout(() => {
  window.__diag && window.__diag('boot: Storage.init() still pending after 6s (IndexedDB hung in WebView?)')
}, 6000)
try {
  await Storage.init()
} catch (e) {
  window.__diag && window.__diag('boot: Storage.init() failed: ' + (e && e.stack || e))
}
clearTimeout(_storageWatch)
console.log('[boot] storage ready, wiring UI')

const $ = (id) => document.getElementById(id)

// Keep the native status-bar tint (Android theme-color meta) in sync with the
// resolved lui theme. The pre-paint script sets it once on load; this observer
// updates it whenever lui.theme() flips html[data-theme] at runtime.
;(function syncThemeColor() {
  const meta = document.querySelector('meta[name="theme-color"]')
  if (!meta) return
  const apply = () => {
    const dark = document.documentElement.dataset.theme === 'dark'
    meta.setAttribute('content', dark ? '#15171c' : '#ffffff')
  }
  apply()
  new MutationObserver(apply).observe(document.documentElement, {
    attributes: true, attributeFilter: ['data-theme'],
  })
})()

// True only inside the Capacitor native shell (Android/iOS), false in the
// browser PWA. Used to pick FCM vs Web Push and the API base below.
function isNativePlatform() {
  return !!(window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function'
    && window.Capacitor.isNativePlatform())
}

// In a Capacitor native build the page is local; network calls (preview)
// must hit the real server. In the browser PWA, same-origin (empty base).
const API_BASE = isNativePlatform() ? 'https://tele.karlson.ru' : ''

/* =================================== toasts =================================== */

/* =================================== sounds =================================== */

const sounds = {
  incoming: new Audio('sounds/bbm_incoming_call.mp3'),
  outgoing: new Audio('sounds/bbm_outgoing_call.mp3'),
  // Reuse the outgoing tone as a soft notification ping for INTRO_FROM.
  notify:   new Audio('sounds/bbm_outgoing_call.mp3'),
}
sounds.incoming.loop = true
sounds.outgoing.loop = true
sounds.notify.loop = false
sounds.notify.volume = 0.5

function playIncoming() { sounds.incoming.currentTime = 0; sounds.incoming.play().catch(()=>{}) }
function playOutgoing() { sounds.outgoing.currentTime = 0; sounds.outgoing.play().catch(()=>{}) }
function playNotify()   { sounds.notify.currentTime = 0; sounds.notify.play().catch(()=>{}) }
function stopAllRings() {
  sounds.incoming.pause(); sounds.incoming.currentTime = 0
  sounds.outgoing.pause(); sounds.outgoing.currentTime = 0
}

function toast(text, kind = '', durationMs = 3500) {
  const el = document.createElement('div')
  el.className = 'toast' + (kind ? ' ' + kind : '')
  el.textContent = text
  el.onclick = () => el.remove()
  $('toasts').appendChild(el)
  if (durationMs > 0) setTimeout(() => el.remove(), durationMs)
}

/* =================================== identity =================================== */

let seeds = loadSeeds()
if (!seeds) {
  seeds = generateSeeds()
  saveSeeds(seeds.xSeed, seeds.edSeed)
}

let nickname = loadNickname()

// First-run nickname dialog blocks until the user picks something.
async function askNicknameIfMissing() {
  if (nickname) return
  return new Promise((resolve) => {
    const $n = (id) => document.getElementById(id)
    $n('dialog-nickname').hidden = false
    $n('nick-input').value = ''
    $n('nick-input').focus()
    const finish = () => {
      const v = $n('nick-input').value.trim()
      if (!v) { $n('nick-input').focus(); return }
      nickname = v
      saveNickname(v)
      $n('dialog-nickname').hidden = true
      resolve()
    }
    $n('nick-save').onclick = finish
    $n('nick-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); finish() }
    })
  })
}
// Fire-and-forget: the nickname dialog is a modal overlay, so it visually
// blocks interaction until filled — but we must NOT await it, or the rest
// of boot (connect + button handlers) never runs and the UI stays dead.
askNicknameIfMissing()
document.getElementById('my-nickname').textContent = nickname || '?'

// Default relay (public: tele.karlson.ru) — shown in settings; overridable
// so anyone can point the app at their own self-hosted server.
const SRV_DEFAULTS = {
  url: 'wss://tele.karlson.ru/ws',
  xpub: '4e8250d28b9b28836aadf6497535ef01056f19982d08ba4059b5c93537c80f06',
  edpub: 'b835840fd3aba7cc4519513f3bbcb1c35170f6aa97d97c16eabdb2e36710d003',
}
function serverConfig() {
  return {
    url:   localStorage.getItem('telefon_ws_url')   || '',
    xpub:  localStorage.getItem('telefon_srv_xpub')  || '',
    edpub: localStorage.getItem('telefon_srv_edpub') || '',
  }
}
const _srv = serverConfig()
const client = new WsClient({
  xSeed: seeds.xSeed, edSeed: seeds.edSeed,
  url:         _srv.url || undefined,
  serverXPub:  _srv.xpub  ? hexU8(_srv.xpub)  : undefined,
  serverEdPub: _srv.edpub ? hexU8(_srv.edpub) : undefined,
})
await client.init()

/* =================================== contacts =================================== */

// In-memory mirror of LocalStorage, plus a runtime "online" flag.
//   idHex -> { qr, label, online: boolean }
const peerBook = (() => {
  const stored = loadPeers()
  for (const v of Object.values(stored)) v.online = false
  return stored
})()

function persist() {
  // strip runtime fields when saving
  const copy = {}
  for (const [k, v] of Object.entries(peerBook)) {
    copy[k] = { qr: v.qr, label: v.label }
  }
  savePeers(copy)
}

// Unread incoming-message counters per contact (idHex -> count). Persisted
// so the badge survives reloads. Bumped when a message arrives for a chat
// that isn't currently open; cleared when that chat is opened.
const unread = (() => {
  try { return JSON.parse(localStorage.getItem('telefon_unread') || '{}') } catch { return {} }
})()
function persistUnread() {
  try { localStorage.setItem('telefon_unread', JSON.stringify(unread)) } catch {}
}
function bumpUnread(idHex) {
  unread[idHex] = (unread[idHex] || 0) + 1
  persistUnread()
  renderContacts()
}
function clearUnread(idHex) {
  if (!unread[idHex]) return
  delete unread[idHex]
  persistUnread()
  renderContacts()
}

// Push all stored peers into the WASM session, ignore duplicates.
for (const p of Object.values(peerBook)) {
  try { client.addPeerFromQr(p.qr) } catch (e) { console.warn('reload peer', e) }
}

function contactInitials(label, idHex) {
  if (label) {
    const parts = label.trim().split(/\s+/)
    return (parts[0][0] || '?') + (parts[1] ? parts[1][0] : '')
  }
  return idHex.slice(0, 2)
}

function renderContacts() {
  const ul = $('contacts')
  ul.innerHTML = ''
  const entries = Object.entries(peerBook).map(([id, p]) => ({
    id, label: p.label || '', online: !!p.online, unread: unread[id] || 0,
  }))
  // Sort into four groups, alphabetical within each. Online always beats
  // offline at every unread level, so live contacts never sink below stale
  // ones: 0) online+unread, 1) offline+unread, 2) online, 3) offline.
  const rank = (c) => (c.unread > 0 ? (c.online ? 0 : 1) : (c.online ? 2 : 3))
  entries.sort((a, b) => {
    const ra = rank(a), rb = rank(b)
    if (ra !== rb) return ra - rb
    return (a.label || a.id).localeCompare(b.label || b.id, 'ru')
  })

  for (const c of entries) {
    const li = document.createElement('li')
    li.className = 'contact'
    li.dataset.id = c.id
    const badge = c.unread > 0
      ? `<div class="unread-badge">${c.unread > 99 ? '99+' : c.unread}</div>`
      : ''
    li.innerHTML = `
      <div class="avatar ${c.online ? '' : 'off'}">${escapeHtml(contactInitials(c.label, c.id))}</div>
      <div class="name">${escapeHtml(c.label || '(unnamed)')}</div>
      <div class="id">${c.id.slice(0, 8)}</div>
      ${badge}
      <div class="dot ${c.online ? 'dot-on' : 'dot-off'}"></div>
    `
    li.onclick = () => {
      // A long-press already opened the context menu; swallow the trailing
      // click so it doesn't also open the chat.
      if (Date.now() - lastContactMenuTs < 600) return
      openCallView(c.id)
    }
    attachLongPress(li, c.id)
    ul.appendChild(li)
  }
  $('contacts-empty').hidden = entries.length > 0
}

// Wire a ~500ms long-press on a contact <li> that opens its context menu.
// Pointer Events cover both touch and mouse. The timer is cancelled if the
// pointer is released early, moves too far (a scroll/drag), or is cancelled.
const LONGPRESS_MS  = 500
const LONGPRESS_MOVE = 10  // px; beyond this it's a scroll, not a press
let lastContactMenuTs = 0  // guards the contact tap from firing after long-press

function attachLongPress(li, idHex) {
  let timer = null
  let startX = 0, startY = 0
  const clear = () => { if (timer) { clearTimeout(timer); timer = null } }
  li.addEventListener('pointerdown', (e) => {
    // Primary button / touch only.
    if (e.button && e.button !== 0) return
    startX = e.clientX; startY = e.clientY
    clear()
    timer = setTimeout(() => {
      timer = null
      lastContactMenuTs = Date.now()
      openContactMenu(idHex, e.clientX, e.clientY)
    }, LONGPRESS_MS)
  })
  li.addEventListener('pointermove', (e) => {
    if (!timer) return
    if (Math.hypot(e.clientX - startX, e.clientY - startY) > LONGPRESS_MOVE) clear()
  })
  li.addEventListener('pointerup', clear)
  li.addEventListener('pointercancel', clear)
  li.addEventListener('pointerleave', clear)
  // Desktop: right-click is the natural equivalent of a long-press.
  li.addEventListener('contextmenu', (e) => {
    e.preventDefault()
    lastContactMenuTs = Date.now()
    openContactMenu(idHex, e.clientX, e.clientY)
  })
}

/* =================================== contact context menu =================================== */

let contactMenuEl = null

function closeContactMenu() {
  if (contactMenuEl) { contactMenuEl.remove(); contactMenuEl = null }
}

// Small action-sheet anchored near the press point. Reuses the .msg-menu look.
function openContactMenu(idHex, x, y) {
  closeContactMenu()
  if (!peerBook[idHex]) return
  const menu = document.createElement('div')
  menu.className = 'msg-menu'
  const item = (label, fn, cls = '') => {
    const b = document.createElement('button')
    b.className = 'msg-menu-item' + (cls ? ' ' + cls : '')
    b.textContent = label
    b.onclick = (e) => { e.stopPropagation(); closeContactMenu(); fn() }
    menu.appendChild(b)
  }
  item('✏️ Rename', () => openRenameDialog(idHex))
  item('🗑 Delete contact', () => openDeleteContactDialog(idHex), 'danger')

  document.body.appendChild(menu)
  const r = menu.getBoundingClientRect()
  const px = Math.max(8, Math.min(x, window.innerWidth  - r.width  - 8))
  const py = Math.max(8, Math.min(y, window.innerHeight - r.height - 8))
  menu.style.left = px + 'px'
  menu.style.top  = py + 'px'
  contactMenuEl = menu
  // Close on the next outside interaction.
  setTimeout(() => {
    document.addEventListener('click',       closeContactMenu, { once: true })
    document.addEventListener('contextmenu', closeContactMenu, { once: true })
  }, 0)
}

function openRenameDialog(idHex) {
  const p = peerBook[idHex]
  if (!p) return
  const dlg = $('dialog-rename')
  const inp = $('rename-input')
  inp.value = p.label || ''
  dlg.hidden = false
  inp.focus()
  inp.select()
  const close = () => { dlg.hidden = true }
  const save = () => {
    const v = inp.value.trim()
    if (peerBook[idHex]) {
      peerBook[idHex].label = v || null
      persist()
      renderContacts()
      // Keep the open chat header in sync if it's this peer.
      if (currentPeerId === idHex) refreshCallHeader()
    }
    close()
  }
  $('rename-cancel').onclick = close
  $('rename-save').onclick = save
  inp.onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); save() }
    else if (e.key === 'Escape') { e.preventDefault(); close() }
  }
}

function openDeleteContactDialog(idHex) {
  const p = peerBook[idHex]
  if (!p) return
  const dlg = $('dialog-delete-contact')
  const name = p.label || idHex.slice(0, 8)
  $('delete-contact-text').textContent =
    `Delete "${name}" and all messages & files? This cannot be undone.`
  dlg.hidden = false
  const close = () => { dlg.hidden = true }
  $('delete-contact-cancel').onclick = close
  $('delete-contact-confirm').onclick = async () => {
    // Tear down everything tied to this peer: contact entry, unread badge,
    // chat history + files, and the WASM session peer (best-effort).
    delete peerBook[idHex]
    persist()
    clearUnread(idHex)
    try { await Storage.clearHistory(idHex) } catch (e) { console.warn('clearHistory', e) }
    try { client.removePeer(hexU8(idHex)) } catch (e) { console.warn('removePeer', e) }
    // If we're looking at this contact's chat, drop back to the list.
    if (currentPeerId === idHex) {
      try { call.hangup() } catch {}
      currentPeerId = null
      showScreen('contacts')
      if (history.state?.screen === 'call') history.back()
    }
    renderContacts()
    close()
    toast(`Deleted ${name}`, 'success')
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' }[c]))
}

/* =================================== INTRO_FROM handler =================================== */

function handleIntroFrom(body) {
  if (body.length < 64) return
  const x_pub  = body.slice(0, 32)
  const ed_pub = body.slice(32, 64)
  const nick   = new TextDecoder().decode(body.slice(64))
  // Reconstruct the K0…-QR string from the keys so the peer entry is
  // identical to one added via paste/invite (single source of truth).
  const combined = new Uint8Array(64)
  combined.set(x_pub, 0); combined.set(ed_pub, 32)
  const b64 = btoa(String.fromCharCode(...combined))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  const qr = 'K0' + b64
  let idU8
  try { idU8 = client.addPeer(x_pub, ed_pub) } catch (e) { console.warn('intro', e); return }
  const idHex = u8hex(idU8)
  const wasNew = !peerBook[idHex]
  // Preserve any local nickname if the user already named this peer; only
  // adopt the introduced nickname for fresh entries.
  peerBook[idHex] = {
    qr,
    label: peerBook[idHex]?.label || nick || null,
    online: true,  // they're online, that's how they just introduced themselves
  }
  persist()
  renderContacts()
  subscribeAll()
  if (wasNew) {
    playNotify()
    flashContact(idHex)
    toast(`${nick || idHex.slice(0,8)} added you to contacts`, 'success')
  }
}

function flashContact(idHex) {
  // Find the li and pulse it for 1.5s using the lui brand accent.
  const li = document.querySelector(`#contacts .contact[data-id="${idHex}"]`)
  if (!li) return
  const accent = getComputedStyle(document.documentElement)
    .getPropertyValue('--accent').trim() || '#ff6200'
  li.animate(
    [{ background: accent }, { background: 'transparent' }],
    { duration: 1500, easing: 'ease-out' },
  )
}

/* =================================== subscribe to presence =================================== */

function subscribeAll() {
  const xs = Object.values(peerBook).map(p => qrXpubBytes(p.qr)).filter(Boolean)
  if (xs.length) client.subscribe(xs)
}

function qrXpubBytes(qr) {
  if (!qr || !qr.startsWith('K0')) return null
  try {
    const body = qr.slice(2).replace(/-/g, '+').replace(/_/g, '/')
    const padded = body + '='.repeat((4 - body.length % 4) % 4)
    const bin = atob(padded)
    const u8 = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i)
    return u8.slice(0, 32)
  } catch { return null }
}

// Fire-and-forget push-wake for an offline recipient. The ClientId is the
// first 8 bytes of the peer's X25519 public key, which is exactly the idHex
// we key the peer book by. No-op if the peer is currently online.
function maybeWake(idHex, isCall = false) {
  if (!idHex || peerBook[idHex]?.online) return
  try { client.sendWake(hexU8(idHex), isCall) } catch (e) { console.warn('wake', e) }
}

function setOnline(xPub, online) {
  // x_pub[..8] is the ClientId by definition.
  const id = u8hex(xPub.slice(0, 8))
  if (!peerBook[id]) return
  peerBook[id].online = online
  renderContacts()
  // Update call-screen header if we're looking at this contact.
  if (currentPeerId === id) refreshCallHeader()
}

/* =================================== screens =================================== */

let currentPeerId = null  // idHex of the contact currently open in call-view

function showScreen(name) {
  for (const id of ['screen-contacts', 'screen-call']) {
    $(id).classList.toggle('active', id === 'screen-' + name)
  }
}

async function openCallView(idHex) {
  currentPeerId = idHex
  // Opening (or switching) a conversation always starts in normal chat mode —
  // drop any leftover search bar/state from the previous peer.
  searchActive = false
  $('search-bar').hidden = true
  $('search-info').textContent = ''
  refreshCallHeader()
  resetCallButtons('idle')
  // Show the screen BEFORE filling the chat: a hidden container has no
  // layout, so scrollHeight reads 0 and the scroll-to-bottom is a no-op.
  showScreen('call')
  await refreshChat()
  // Opening the chat means the user is looking at it — read-ack all
  // incoming messages so the sender sees ✓✓, and clear the unread badge.
  markHistoryRead(idHex)
  clearUnread(idHex)
  // Push a history entry so the browser/system back-button (Backspace on
  // desktop, swipe-back on Android, etc.) closes the call instead of
  // leaving it running invisibly behind the contacts list.
  history.pushState({ screen: 'call', peer: idHex }, '', '#call')
}

window.addEventListener('popstate', (e) => {
  // Lightbox-first: a back gesture closes the overlay rather than the
  // underlying call/contacts screen.
  if (!$('lightbox').hidden) { closeLightbox({ fromPopState: true }); return }
  // If after this navigation the new state still says we are on the
  // call screen (e.g. we closed a lightbox sitting on top of a call),
  // do nothing — leave the call running.
  if ($('screen-call').classList.contains('active') && !e.state?.screen) {
    call.hangup()
    currentPeerId = null
    showScreen('contacts')
  }
})

// Android hardware/gesture back button. Capacitor does NOT route it through
// our SPA history by default — without this it just exits the app. Mirror
// the popstate logic: close lightbox → leave call → otherwise minimize.
;(() => {
  const CapApp = window.Capacitor?.Plugins?.App
  if (!CapApp || !CapApp.addListener) return
  CapApp.addListener('backButton', () => {
    // A lui window (e.g. Settings) takes priority — back closes it, not the app.
    const topWin = document.querySelector('.win')
    if (topWin && window.lui) { window.lui.closeWin(topWin); return }
    if (!$('lightbox').hidden) { closeLightbox(); return }
    if ($('screen-call').classList.contains('active')) {
      call.hangup()
      currentPeerId = null
      showScreen('contacts')
      return
    }
    // On the contacts root — send the app to background rather than killing it.
    CapApp.minimizeApp ? CapApp.minimizeApp() : CapApp.exitApp()
  })
})()

/* =================================== lightbox =================================== */

let lightboxUrl = null
function openLightbox(url) {
  lightboxUrl = url
  $('lightbox-img').src = url
  $('lightbox').hidden = false
  // Push a history entry that *still* identifies the underlying screen
  // (call), so when the lightbox is popped the popstate handler can tell
  // we are returning to that call, not exiting it.
  const baseState = (history.state && history.state.screen)
    ? { ...history.state }
    : { screen: currentPeerId ? 'call' : 'contacts', peer: currentPeerId }
  history.pushState({ ...baseState, lightbox: true }, '', '#image')
  document.addEventListener('keydown', onLightboxKey)
}
function closeLightbox(opts = {}) {
  // Idempotent: detach the keydown listener even if already hidden, just
  // in case openLightbox attached one but we somehow took a different
  // code path to hide.
  document.removeEventListener('keydown', onLightboxKey)
  if ($('lightbox').hidden) return
  $('lightbox').hidden = true
  $('lightbox-img').removeAttribute('src')
  if (lightboxUrl) { URL.revokeObjectURL(lightboxUrl); lightboxUrl = null }
  // For programmatic close (✕ click, Esc), undo the history entry. The
  // resulting popstate handler will run with our `screen:'call'` flag
  // still set, so it won't tear down the call.
  if (!opts.fromPopState && history.state?.lightbox) history.back()
}
function onLightboxKey(e) {
  if (e.key === 'Escape') { e.preventDefault(); closeLightbox() }
}
$('lightbox-close').onclick = () => closeLightbox()
$('lightbox-img').onclick = () => closeLightbox()

// Last-ditch: tab/window closing — try to send a HANGUP before we go.
window.addEventListener('pagehide', () => { try { call.hangup() } catch {} })

function refreshCallHeader() {
  const p = peerBook[currentPeerId]
  if (!p) return
  $('call-peer-name').textContent = p.label || currentPeerId.slice(0, 8)
  $('call-peer-online').className = 'dot ' + (p.online ? 'dot-on' : 'dot-off')
}

// (defined below as async — older sync stub no longer used)

function resetCallButtons(state) {
  const inCall = state === 'connecting' || state === 'connected'
  // Без активного звонка чат занимает весь экран; во время звонка видео
  // забирает место, а чат становится компактной нижней панелью.
  $('screen-call').classList.toggle('calling', inCall)
  $('call-btn').hidden    = inCall
  $('hangup-btn').hidden  = !inCall
  $('switch-cam').hidden  = !inCall
  $('mute-btn').hidden    = !inCall
  $('video-btn').hidden   = !inCall
  $('speaker-btn').hidden = !inCall
  $('res-select').hidden  = !inCall
  // Device pickers follow the same lifecycle; populateDeviceSelectors() may
  // still re-hide them afterwards if only one device of a kind exists.
  $('cam-select').hidden  = !inCall
  $('mic-select').hidden  = !inCall
  $('call-state').textContent = state
}

/* =================================== chat =================================== */

// In-memory shadow of the on-screen chat so we can update individual
// messages (status changes) without re-querying IDB.
const renderedMessages = new Map()  // msgId -> DOM element

// Inbound chunks staging: file_id -> [chunks indexed by chunk_idx].
const inboundChunks = new Map()
const CHUNK_BYTES   = 32 * 1024   // 32 KB per FILE_CHUNK frame

// Read-ack incoming messages when the chat is opened. Track which ids we've
// already acked this session so re-opening the chat doesn't re-blast read-acks
// for the whole history every time.
const readAcked = new Set()
async function markHistoryRead(idHex) {
  const peerId = hexU8(idHex)
  const rows = await Storage.history(idHex)
  for (const m of rows) {
    if (m.dir === 'in' && !readAcked.has(m.id)) {
      client.sendReadAck(peerId, m.id)
      readAcked.add(m.id)
    }
  }
}

// Windowed chat rendering. Opening a conversation only renders the most
// recent CHAT_WINDOW messages; older ones are paged in on demand as the user
// scrolls toward the top (see the #chat scroll handler below). This keeps the
// DOM small and the open-chat path fast even for very long histories.
const CHAT_WINDOW    = 50   // initial tail rendered on open
const CHAT_PAGE      = 25   // batch size when paging older messages upward
const SCROLL_TRIGGER = 80   // px from the top that triggers an older-page load

let oldestLoadedTs = null   // ts of the oldest message currently in the DOM
let noMoreOlder    = false  // true once we've reached the start of history
let isLoadingOlder = false  // guard against overlapping upward loads
let searchActive   = false  // true while the search bar is showing results

// Render one stored message into a DOM node (file rows are async).
async function renderMessageNode(m) {
  return isFileRef(m.body) ? await renderFileMessage(m) : renderTextMessage(m)
}

async function refreshChat() {
  const box = $('chat')
  box.innerHTML = ''
  renderedMessages.clear()
  oldestLoadedTs = null
  noMoreOlder = false
  isLoadingOlder = false
  if (!currentPeerId) return
  const rows = await Storage.historyTail(currentPeerId, CHAT_WINDOW)
  for (const m of rows) box.appendChild(await renderMessageNode(m))
  if (rows.length > 0) oldestLoadedTs = rows[0].ts
  // If the tail already covers the whole history there's nothing above it.
  if (rows.length < CHAT_WINDOW) noMoreOlder = true
  scrollChatToBottom()
  // Images decode asynchronously and grow the chat after first layout;
  // re-pin to the bottom as each one resolves so the newest stays in view.
  for (const img of box.querySelectorAll('img')) {
    if (!img.complete) img.addEventListener('load', scrollChatToBottom, { once: true })
  }
}

// Page older messages in when the user scrolls near the top. The tricky part
// is preserving the visual position: prepending nodes grows scrollHeight, so
// we re-anchor scrollTop by the height delta to keep the content from jumping.
async function loadOlderMessages() {
  if (isLoadingOlder || noMoreOlder || !currentPeerId || oldestLoadedTs == null) return
  isLoadingOlder = true
  try {
    const rows = await Storage.historyBefore(currentPeerId, oldestLoadedTs, CHAT_PAGE)
    // The query bound is inclusive, so the page can re-include rows already
    // on screen (those sharing the boundary timestamp). Drop them by id.
    const fresh = rows.filter((m) => !renderedMessages.has(m.id))
    if (fresh.length === 0) { noMoreOlder = true; return }
    const box = $('chat')
    const prevHeight = box.scrollHeight
    const prevTop    = box.scrollTop
    // Build then prepend in order: the oldest of the batch ends up on top.
    const frag = document.createDocumentFragment()
    for (const m of fresh) frag.appendChild(await renderMessageNode(m))
    box.insertBefore(frag, box.firstChild)
    oldestLoadedTs = fresh[0].ts
    // Fewer than a full page of *raw* rows means we've hit the start.
    if (rows.length < CHAT_PAGE) noMoreOlder = true
    // Restore the viewport: shift down by exactly how much we grew on top.
    box.scrollTop = prevTop + (box.scrollHeight - prevHeight)
  } finally {
    isLoadingOlder = false
  }
}

// Attach the upward-paging scroll listener once, at module load. It is inert
// while in search mode (searchActive) or when there's nothing older to fetch.
$('chat').addEventListener('scroll', () => {
  if (searchActive) return
  if (oldestLoadedTs != null && $('chat').scrollTop < SCROLL_TRIGGER) loadOlderMessages()
})

// Pin the chat to the newest message. Double rAF waits for layout to settle
// (screen just became visible / nodes just inserted) before measuring.
function scrollChatToBottom() {
  const box = $('chat')
  if (!box) return
  requestAnimationFrame(() => {
    requestAnimationFrame(() => { box.scrollTop = box.scrollHeight })
  })
}

// Matches bare http(s) URLs. The trailing class excludes characters that
// can't appear inside a URL; a final cleanup trims common trailing
// punctuation that is usually sentence-level, not part of the link.
const URL_RE = /https?:\/\/[^\s<>"'()]+/gi

function trimTrailingPunct(url) {
  return url.replace(/[.,;:!?»)\]]+$/, '')
}

function renderTextMessage(m) {
  const row = makeMsgShell(m)
  const text = document.createElement('span')
  text.className = 'msg-text'
  linkifyInto(text, m.body)
  row.insertBefore(text, row.firstChild)
  // Fire-and-forget: harvest a link preview for the first URL, if any.
  maybeAttachPreview(row, m)
  return row
}

// Render text into `span`, turning bare URLs into clickable anchors.
function linkifyInto(span, body) {
  let last = 0
  for (const match of body.matchAll(URL_RE)) {
    const raw = match[0]
    const url = trimTrailingPunct(raw)
    const start = match.index
    if (start > last) span.appendChild(document.createTextNode(body.slice(last, start)))
    const a = document.createElement('a')
    a.className = 'msg-link'
    a.href = url
    a.target = '_blank'
    a.rel = 'noopener noreferrer'
    a.textContent = url
    span.appendChild(a)
    // Any trailing punctuation we trimmed off stays as plain text.
    last = start + url.length
  }
  if (last < body.length) span.appendChild(document.createTextNode(body.slice(last)))
}

const previewFetched = new Set()  // msg ids we've already tried, avoids refetch on re-render

async function maybeAttachPreview(row, m) {
  if (previewFetched.has(m.id)) return
  const match = m.body.match(URL_RE)
  if (!match) return
  previewFetched.add(m.id)
  const url = trimTrailingPunct(match[0])
  let p
  try {
    const resp = await fetch(API_BASE + '/preview?u=' + encodeURIComponent(url))
    if (!resp.ok) return
    p = await resp.json()
  } catch { return }
  if (!p || (!p.title && !p.description && !p.image)) return
  // The row may have been re-rendered (history reload) while we awaited;
  // only attach if this exact node is still in the document.
  if (!row.isConnected) return
  // Don't double-attach if a card for this id already exists.
  if (document.querySelector(`.preview-card[data-preview-for="${cssEscape(m.id)}"]`)) return
  const card = buildPreviewCard(p)
  card.classList.add(m.dir === 'out' ? 'me' : 'them')
  card.dataset.previewFor = m.id
  row.after(card)
  const chat = $('chat')
  if (chat) chat.scrollTop = chat.scrollHeight
}

function cssEscape(s) {
  return (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/["\\]/g, '\\$&')
}

function buildPreviewCard(p) {
  const a = document.createElement('a')
  a.className = 'preview-card'
  a.href = p.url
  a.target = '_blank'
  a.rel = 'noopener noreferrer'
  if (p.image) {
    const img = document.createElement('img')
    img.className = 'preview-img'
    img.src = p.image
    img.loading = 'lazy'
    img.alt = ''
    img.onerror = () => img.remove()
    a.appendChild(img)
  }
  const body = document.createElement('div')
  body.className = 'preview-body'
  if (p.site_name) {
    const s = document.createElement('div'); s.className = 'preview-site'
    s.textContent = p.site_name; body.appendChild(s)
  }
  if (p.title) {
    const t = document.createElement('div'); t.className = 'preview-title'
    t.textContent = p.title; body.appendChild(t)
  }
  if (p.description) {
    const d = document.createElement('div'); d.className = 'preview-desc'
    d.textContent = p.description; body.appendChild(d)
  }
  a.appendChild(body)
  return a
}

async function renderFileMessage(m) {
  const row = makeMsgShell(m)
  const fileId = fileIdOf(m.body)
  const f = await Storage.getFile(fileId)
  const box = document.createElement('div')
  box.className = 'msg-file'
  if (!f) {
    box.textContent = '[missing file]'
  } else if (f.mime?.startsWith('image/')) {
    const img = document.createElement('img')
    img.className = 'thumb'
    img.alt = f.name
    img.src = URL.createObjectURL(f.blob || f.thumb_blob)
    img.onclick = () => {
      // Suppress the click that trails a long-press (which opened the menu).
      if (Date.now() - lastMenuTs < 600) return
      if (f.blob) openLightbox(URL.createObjectURL(f.blob))
    }
    box.appendChild(img)
    box.appendChild(fileMeta(f))
  } else if (f.mime?.startsWith('audio/')) {
    if (f.blob) {
      const au = document.createElement('audio')
      au.controls = true; au.src = URL.createObjectURL(f.blob)
      box.appendChild(au)
    }
    box.appendChild(fileMeta(f))
  } else if (f.mime?.startsWith('video/')) {
    if (f.blob) {
      const v = document.createElement('video')
      v.controls = true; v.src = URL.createObjectURL(f.blob)
      box.appendChild(v)
    }
    box.appendChild(fileMeta(f))
  } else {
    box.appendChild(fileMeta(f))
  }
  row.insertBefore(box, row.firstChild)
  return row
}

// Strip path separators and other characters that are unsafe (or merely
// awkward) in a filesystem path. Falls back to a generic name if the result
// would be empty, so writeFile() always gets a usable leaf name.
function sanitizeFileName(name) {
  const cleaned = String(name || '')
    .replace(/[\/\\]/g, '_')        // no directory traversal
    .replace(/[\x00-\x1f<>:"|?*]/g, '_')
    .replace(/^\.+/, '')            // no leading dots (hidden / "..")
    .trim()
  return cleaned || 'file'
}

// Convert a Blob to a bare base64 string (no data: URI prefix), as required
// by Filesystem.writeFile. Done via FileReader.readAsDataURL so the browser
// handles the binary→base64 encoding natively (no manual chunking needed).
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result || ''
      const comma = result.indexOf(',')
      // result is "data:<mime>;base64,<payload>" — keep only the payload.
      resolve(comma >= 0 ? result.slice(comma + 1) : result)
    }
    reader.onerror = () => reject(reader.error || new Error('FileReader failed'))
    reader.readAsDataURL(blob)
  })
}

// Native (Capacitor) path for opening/saving a received file. The browser's
// `<a download>` does not work inside an Android WebView for blob URLs, so we
// instead write the blob to the app cache and hand its file:// URI to the
// system share sheet, which offers "open in…" (PDF viewer, etc.) and "save".
async function openFileNative(f) {
  try {
    const FS = window.Capacitor?.Plugins?.Filesystem
    const Share = window.Capacitor?.Plugins?.Share
    if (!FS || !Share) {
      console.warn('Filesystem/Share plugin unavailable (run cap sync?)')
      toast('Cannot open file')
      return
    }
    const name = sanitizeFileName(f.name)
    const base64 = await blobToBase64(f.blob)
    // CACHE is transient app storage — fine for a hand-off via the chooser.
    await FS.writeFile({ path: name, data: base64, directory: 'CACHE' })
    const { uri } = await FS.getUri({ path: name, directory: 'CACHE' })
    await Share.share({ title: f.name, url: uri })
  } catch (e) {
    console.warn('openFileNative failed:', e)
    toast('Cannot open file')
  }
}

function fileMeta(f) {
  const div = document.createElement('div')
  div.className = 'filemeta'
  const size = humanBytes(f.size)
  if (f.blob && isNativePlatform()) {
    // In the native shell a blob `<a download>` is a no-op; route taps through
    // the system chooser instead (PDF viewer, "save to Downloads", etc.).
    const btn = document.createElement('span')
    btn.className = 'filelink'
    btn.textContent = `📎 ${f.name} · ${size}`
    btn.onclick = () => openFileNative(f)
    div.appendChild(btn)
  } else if (f.blob) {
    const a = document.createElement('a')
    a.href = URL.createObjectURL(f.blob)
    a.download = f.name
    a.textContent = `📎 ${f.name}`
    div.appendChild(a)
    const sz = document.createElement('span'); sz.textContent = `· ${size}`
    div.appendChild(sz)
  } else {
    div.textContent = `📎 ${f.name} · ${size} (transferring…)`
  }
  return div
}

function humanBytes(n) {
  if (n < 1024)        return `${n} B`
  if (n < 1024 * 1024) return `${(n/1024).toFixed(1)} KB`
  return `${(n/1024/1024).toFixed(1)} MB`
}

function makeMsgShell(m) {
  const row = document.createElement('div')
  row.className = 'msg ' + (m.dir === 'out' ? 'me' : 'them')
  row.dataset.id = m.id
  if (m.dir === 'out') {
    const tick = document.createElement('span')
    tick.className = 'msg-status'
    tick.textContent = statusGlyph(m.status)
    row.appendChild(tick)
  }
  // Explicit actions handle (⋮). Tapping it opens the per-message menu, so we
  // don't need long-press on the bubble — that lets native text selection
  // (long-press to select/copy a link) work normally.
  const dots = document.createElement('button')
  dots.className = 'msg-actions'
  dots.textContent = '⋮'
  dots.title = 'actions'
  dots.onclick = (e) => {
    e.stopPropagation()
    const r = dots.getBoundingClientRect()
    openMsgMenu(row, r.left, r.bottom)
  }
  row.appendChild(dots)
  renderedMessages.set(m.id, row)
  return row
}

// Backwards-compatible alias used in a couple of places.
function appendChatRow(m) {
  const node = isFileRef(m.body)
    ? null  // file rows are produced asynchronously elsewhere
    : renderTextMessage(m)
  if (node) $('chat').appendChild(node)
  return node
}

function statusGlyph(status) {
  switch (status) {
    case 'pending':   return '⏱'
    case 'sent':      return '✓'
    case 'delivered': return '✓✓'
    case 'read':      return '✓✓'
    default:          return ''
  }
}

function updateRowStatus(msgId, status) {
  const row = renderedMessages.get(msgId)
  if (!row) return
  const tick = row.querySelector('.msg-status')
  if (tick) tick.textContent = statusGlyph(status)
}

// Remove a message's chat row and any link-preview card attached to it.
function removeMessageRow(msgId) {
  const row = renderedMessages.get(msgId)
  if (row) {
    const card = row.nextElementSibling
    if (card && card.classList.contains('preview-card') &&
        card.dataset.previewFor === msgId) card.remove()
    row.remove()
    renderedMessages.delete(msgId)
  }
  previewFetched.delete(msgId)
}

// Replace a text message's body in place (used on incoming + local edit).
function updateMessageBody(msgId, newBody) {
  const row = renderedMessages.get(msgId)
  if (!row) return
  const span = row.querySelector('.msg-text')
  if (!span) return
  span.textContent = ''
  linkifyInto(span, newBody)
  if (!row.querySelector('.msg-edited')) {
    const tag = document.createElement('span')
    tag.className = 'msg-edited'
    tag.textContent = ' (edited)'
    span.appendChild(tag)
  } else {
    span.appendChild(row.querySelector('.msg-edited'))
  }
  // Refresh the link preview for the new text.
  const old = row.nextElementSibling
  if (old && old.classList.contains('preview-card') && old.dataset.previewFor === msgId) old.remove()
  previewFetched.delete(msgId)
  maybeAttachPreview(row, { id: msgId, body: newBody, dir: row.classList.contains('me') ? 'out' : 'in' })
}

/* =================================== call manager =================================== */

const call = new CallManager(client, {
  log: (s) => console.log(s),
  onLocalStream:  (s) => { $('my-video').srcObject = s   || null },
  onRemoteStream: (s) => { $('peer-video').srcObject = s || null },
  onState: (s) => {
    if (currentPeerId) resetCallButtons(s)
    if (s === 'connecting' || s === 'connected') {
      // Media is open by now, so device labels are available — fill the
      // camera / microphone pickers. Safe to call repeatedly.
      populateDeviceSelectors()
    }
    if (s === 'connected') {
      $('mute-btn').textContent = '🔇 Mute'
      stopAllRings()
    }
    if (s === 'hangup' || s === 'rejected' || s === 'peer hangup' || s === 'idle' || s === 'failed' || s === 'closed') {
      resetCallButtons('idle')
      stopAllRings()
    }
  },
  onText: async (peerId, msgId, text) => {
    const idHex = u8hex(peerId)
    const isNew = await Storage.saveIncoming(idHex, msgId, text, Date.now())
    // ACK regardless — idempotent on the sender side too.
    client.sendDeliveryAck(peerId, msgId)
    if (!isNew) return
    if (currentPeerId === idHex) {
      // While searching we keep the result list intact; the message is stored
      // and shows up once search is closed. Read-ack it either way.
      if (!searchActive) {
        appendChatRow({ id: msgId, dir: 'in', body: text, status: 'received' })
        $('chat').scrollTop = $('chat').scrollHeight
      }
      client.sendReadAck(peerId, msgId); readAcked.add(msgId)  // chat open → read right away
    } else {
      const p = peerBook[idHex]
      toast(`${p?.label || idHex.slice(0, 8)}: ${text}`)
      bumpUnread(idHex)
    }
  },
  onDelivered: async (peerId, msgId) => {
    await Storage.markStatus(msgId, 'delivered')
    updateRowStatus(msgId, 'delivered')
  },
  onRead: async (peerId, msgId) => {
    await Storage.markStatus(msgId, 'read')
    updateRowStatus(msgId, 'read')
  },
  onMsgDelete: async (peerId, msgId) => {
    const idHex = u8hex(peerId)
    await Storage.deleteMessage(msgId)
    if (currentPeerId === idHex) removeMessageRow(msgId)
  },
  onMsgEdit: async (peerId, msgId, text) => {
    const idHex = u8hex(peerId)
    const ok = await Storage.editMessage(msgId, text)
    if (ok && currentPeerId === idHex) updateMessageBody(msgId, text)
  },
  // ---- file transfer ----
  onFileOffer: async (peerId, meta) => {
    // Store metadata + thumbnail (if image) so we can render a preview
    // immediately. Blob comes together in FILE_END.
    let thumb_blob = null
    if (meta.thumb_b64) {
      try {
        const bin = atob(meta.thumb_b64)
        const u8 = new Uint8Array(bin.length)
        for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i)
        thumb_blob = new Blob([u8], { type: 'image/jpeg' })
      } catch {}
    }
    await Storage.saveFileMeta({ ...meta, thumb_blob })
    inboundChunks.set(meta.id, [])
  },
  onFileChunk: (peerId, fileId, idx, data) => {
    const arr = inboundChunks.get(fileId)
    if (!arr) return
    arr[idx] = data
  },
  onFileEnd: async (peerId, fileId, msgId) => {
    const arr = inboundChunks.get(fileId)
    if (!arr) return
    const meta = await Storage.getFile(fileId)
    if (!meta) return
    const blob = new Blob(arr.filter(Boolean), { type: meta.mime })
    await Storage.saveFileBlob(fileId, blob)
    inboundChunks.delete(fileId)
    const idHex = u8hex(peerId)
    const isNew = await Storage.saveIncoming(idHex, msgId, `%${fileId}`, Date.now())
    client.sendDeliveryAck(peerId, msgId)
    if (!isNew) return
    if (currentPeerId === idHex) {
      const row = await renderFileMessage({ id: msgId, dir: 'in', body: `%${fileId}`, status: 'received' })
      $('chat').appendChild(row)
      $('chat').scrollTop = $('chat').scrollHeight
      client.sendReadAck(peerId, msgId); readAcked.add(msgId)  // chat open → read right away
    } else {
      const p = peerBook[idHex]
      toast(`${p?.label || idHex.slice(0,8)} sent: ${meta.name}`)
      bumpUnread(idHex)
    }
  },
  onIncomingCall: (peerId) => {
    const idHex = u8hex(peerId)
    const name = peerBook[idHex]?.label || idHex.slice(0, 8)
    $('incoming-name').textContent = `${name} is calling.`
    $('dialog-incoming').hidden = false
    pendingIncoming = { peerId, idHex }
    playIncoming()
  },
})
call.attach()

let pendingIncoming = null

$('incoming-accept').onclick = async () => {
  if (!pendingIncoming) return
  const { peerId, idHex } = pendingIncoming
  pendingIncoming = null
  $('dialog-incoming').hidden = true
  stopAllRings()
  openCallView(idHex)
  await call.acceptIncoming(peerId)
}
$('incoming-reject').onclick = () => {
  if (!pendingIncoming) return
  call.rejectIncoming(pendingIncoming.peerId)
  pendingIncoming = null
  $('dialog-incoming').hidden = true
  stopAllRings()
}

/* =================================== client wiring =================================== */

// Map raw WS state to short user-facing status + LED class.
const STATE_LABELS = {
  connecting:    ['offline',         'dot-off'],
  handshaking:   ['connecting…',     'dot-warn'],
  established:   ['online',          'dot-on'],
  closed:        ['offline',         'dot-off'],
  'reconnect-in':['reconnecting…',   'dot-warn'],
  rejected:      ['session taken',   'dot-off'],
  backoff:       ['offline',         'dot-off'],
  idle:          ['offline',         'dot-off'],
  disconnected:  ['offline',         'dot-off'],
}

client.onState = ({ state, detail }) => {
  const [text, dotClass] = STATE_LABELS[state] || [state, 'dot-off']
  $('conn-text').textContent = text
  $('conn-led').className = 'dot ' + dotClass
  const banner = $('fatal-banner')
  if (state === 'rejected') {
    banner.hidden = false
    banner.textContent = 'Session in use — close other windows that have this page open.'
  } else {
    banner.hidden = true
  }
  // Re-subscribe on (re-)connect so presence works after a reconnect.
  if (state === 'established') {
    subscribeAll()
    // Register/refresh our push token now that the server can receive it.
    // Idempotent — safe to call on every (re-)connect. The native app uses
    // FCM (kind 1); the browser PWA uses Web Push (kind 2).
    if (isNativePlatform()) {
      registerFcm()
    } else {
      registerWebPush()
    }
  }
}

client.onConsole = (line) => console.log(line)

client.onServer = (msg) => {
  if (msg.cmd === CMD.PEER_ONLINE) {
    for (let i = 0; i + 32 <= msg.body.length; i += 32) {
      const xPub = msg.body.slice(i, i + 32)
      setOnline(xPub, true)
      // x_pub[..8] is the ClientId — try to flush anything we owe them.
      const idHex = u8hex(xPub.slice(0, 8))
      flushOutboxFor(idHex).catch(e => console.warn('flush', e))
    }
  } else if (msg.cmd === CMD.PEER_OFFLINE) {
    for (let i = 0; i + 32 <= msg.body.length; i += 32) {
      setOnline(msg.body.slice(i, i + 32), false)
    }
  } else if (msg.cmd === CMD.INTRO_FROM) {
    handleIntroFrom(msg.body)
  }
}

// Do NOT await: a hung WASM/WS connect must not block wiring up the UI
// (otherwise every button below stays dead). Connect in the background.
console.log('[boot] dispatching connect')
client.connect()
  .then(() => console.log('[boot] connect() resolved'))
  .catch((e) => {
    console.error('[boot] connect failed:', e)
    window.__diag && window.__diag('connect failed: ' + (e && e.stack || e))
  })
// Watchdog: if the WASM module or socket never settles, surface it instead
// of silently sitting on "connecting".
setTimeout(() => {
  if (!client.session) {
    window.__diag && window.__diag('Still initializing after 10s — WASM (ws_wasm_bg.wasm) likely failed to load in the WebView. Check MIME/path.')
  }
}, 10000)
renderContacts()

/* =================================== invite link auto-import =================================== */

const incomingInvite = readInviteFromUrl()
if (incomingInvite) {
  $('add-qr').value = incomingInvite
  $('add-error').hidden = true
  // Try to pre-fill the label from the nickname embedded in the QR.
  let inviteNick = ''
  try { inviteNick = client.session.constructor.nicknameFromQr(incomingInvite) } catch {}
  $('add-label').value = inviteNick
  $('dialog-add').hidden = false
  clearInviteFromUrl()
}

/* =================================== add-contact dialog =================================== */

function extractQrText(input) {
  const t = (input || '').trim()
  if (!t) return null
  if (t.startsWith('K0')) return t
  try {
    const u = new URL(t)
    const p = u.searchParams.get('peer')
    if (p && p.startsWith('K0')) return p
  } catch {}
  return null
}

$('btn-add-contact').onclick = () => {
  $('add-qr').value = ''
  $('add-label').value = ''
  $('add-error').hidden = true
  $('dialog-add').hidden = false
  $('add-qr').focus()
}

// When user pastes a QR text or invite URL into the field, try to extract
// the embedded nickname and prefill the label input.
$('add-qr').addEventListener('input', () => {
  const qr = extractQrText($('add-qr').value)
  if (!qr) return
  try {
    const nick = client.session.constructor.nicknameFromQr(qr) // static
    if (nick && !$('add-label').value) $('add-label').value = nick
  } catch {}
})
$('add-cancel').onclick = () => { $('dialog-add').hidden = true }
$('add-save').onclick = () => {
  const qr = extractQrText($('add-qr').value)
  if (!qr) {
    showAddError('Does not look like a peer code.')
    return
  }
  const label = $('add-label').value.trim() || null
  try {
    const idU8 = client.addPeerFromQr(qr)
    const idHex = u8hex(idU8)
    peerBook[idHex] = { qr, label, online: false }
    persist()
    renderContacts()
    subscribeAll()
    // The other side does not yet have our keys — push them via the
    // server. If the peer is offline right now, the server drops the
    // INTRODUCE silently; user can repeat via a "say hi" button later.
    client.introduce(idU8, nickname || '')
    $('dialog-add').hidden = true
    toast(`+ ${label || idHex.slice(0, 8)}`, 'success')
  } catch (e) {
    showAddError(`Code rejected: ${e}`)
  }
}
function showAddError(text) {
  const el = $('add-error')
  el.textContent = text
  el.hidden = false
}

/* =================================== invite share =================================== */

/* =================================== web push =================================== */

// VAPID application server key (public half). The server holds the private
// half and signs Web Push requests with it. Must match the server config.
const VAPID_PUBLIC = 'BNFDN_DiwG9TUBfqEaPBwWdhWk427eV8A8fUbjR56STlN_eXHAZ2IJomddMVKIRpE7k-OY1dqg5oUjpAexoCrkw'

// Convert a base64url-encoded VAPID key into the Uint8Array that the
// PushManager.subscribe applicationServerKey option expects.
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(base64)
  const out = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

// Subscribe to Web Push and hand the subscription to the server so it can
// wake this client when a peer messages/calls it while offline. Idempotent:
// getSubscription() returns the existing one on repeat calls. Push is not
// critical to core operation — never let a failure here break startup.
async function registerWebPush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    console.warn('web push unsupported in this environment')
    return
  }
  try {
    const reg = await navigator.serviceWorker.ready
    if (Notification.permission === 'default') {
      const perm = await Notification.requestPermission()
      if (perm !== 'granted') return
    }
    if (Notification.permission !== 'granted') return
    let sub = await reg.pushManager.getSubscription()
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC),
      })
    }
    client.sendPushRegister(2, JSON.stringify(sub.toJSON()))
  } catch (e) {
    console.warn('web push register failed:', e)
  }
}

/* =================================== fcm push (native) =================================== */

// Guard so the @capacitor/push-notifications listeners are wired exactly
// once, even though registerFcm() runs on every (re-)connect.
let _fcmListenersWired = false

// Register for Firebase Cloud Messaging in the native Capacitor app and hand
// the FCM token to the server (kind 1) so it can wake us when offline. The
// plugin is reached through the runtime-injected window.Capacitor.Plugins
// global (this project ships unbundled www files and accesses every plugin —
// e.g. App — the same way), so a browser build never trips on a missing
// module. Push is not critical to core operation; never let a failure here
// break startup.
async function registerFcm() {
  if (!isNativePlatform()) return
  try {
    const PushNotifications = window.Capacitor?.Plugins?.PushNotifications
    if (!PushNotifications) {
      console.warn('PushNotifications plugin unavailable (run cap sync?)')
      return
    }

    if (!_fcmListenersWired) {
      _fcmListenersWired = true

      // The token arrives asynchronously after register(); also fires again
      // when the OS rotates it. Always re-send so the server stays current.
      PushNotifications.addListener('registration', (token) => {
        try { client.sendPushRegister(1, token.value) }
        catch (e) { console.warn('fcm token send failed:', e) }
      })

      PushNotifications.addListener('registrationError', (err) => {
        console.warn('fcm registration error:', err)
      })

      // When the app is in the foreground the OS does NOT display an FCM
      // notification — it is delivered here instead. A toast is invisible
      // with the screen off, so raise a real LOCAL notification (system tray,
      // sound via the telefon_messages channel) so it's seen regardless.
      PushNotifications.addListener('pushNotificationReceived', (notif) => {
        console.log('fcm push received (foreground):', notif)
        const title = notif?.title || notif?.data?.title || 'telefon'
        const body  = notif?.body  || notif?.data?.body  || 'New message'
        try {
          const LN = window.Capacitor?.Plugins?.LocalNotifications
          if (LN) {
            LN.schedule({ notifications: [{
              id: Date.now() % 1000000,
              title, body,
              channelId: 'telefon_messages',
            }] })
          }
        } catch (e) { console.warn('local notif:', e) }
        try { toast([title, body].filter(Boolean).join(': ')) } catch {}
      })
    }

    // Ask for the POST_NOTIFICATIONS permission (Android 13+) before
    // registering. On older Android requestPermissions() resolves granted.
    let perm = await PushNotifications.checkPermissions()
    if (perm.receive === 'prompt' || perm.receive === 'prompt-with-rationale') {
      perm = await PushNotifications.requestPermissions()
    }
    if (perm.receive !== 'granted') {
      console.warn('fcm permission not granted:', perm.receive)
      return
    }

    // Create a high-importance channel so notifications make sound + show a
    // heads-up banner. FCM payloads target this channel_id ("telefon_messages").
    // Without an explicit HIGH channel, Android's default is silent.
    try {
      await PushNotifications.createChannel({
        id: 'telefon_messages',
        name: 'Messages & calls',
        description: 'Incoming messages and calls',
        importance: 5,    // MAX → heads-up banner + sound
        sound: 'default',
        vibration: true,
        visibility: 1,    // visible on the lock screen
      })
    } catch (e) { console.warn('createChannel failed:', e) }

    // Triggers the FCM registration; the token is delivered via the
    // 'registration' listener above.
    await PushNotifications.register()
  } catch (e) {
    console.warn('fcm register failed:', e)
  }
}

/* =================================== PWA install =================================== */

// Register the Service Worker once. Without it Chrome won't surface the
// install affordance.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(e => console.warn('sw register:', e))
}

// The browser fires `beforeinstallprompt` when the page is install-eligible
// (manifest + SW + served over HTTPS). We stash the event so we can show
// our own button at a moment of the user's choosing.
let deferredInstallPrompt = null
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault()
  deferredInstallPrompt = e
})
window.addEventListener('appinstalled', () => {
  deferredInstallPrompt = null
  $('btn-install').hidden = true
  toast('App installed', 'success')
})
const NATIVE_APP = !!(window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function'
  && window.Capacitor.isNativePlatform())
if (NATIVE_APP) {
  // In the native app there's nothing to "install" — repurpose the button
  // as "Update" (check the server for a newer build and download it).
  $('btn-install').textContent = '⬆ Обновить'
} else if (matchMedia('(display-mode: standalone)').matches) {
  $('btn-install').hidden = true  // installed PWA — nothing to install
}
// In a mobile browser (not the native app), offer the APK download.
if (!NATIVE_APP && /Android/.test(navigator.userAgent)) {
  $('btn-apk').hidden = false
}
$('btn-apk').onclick = () => {
  window.open('https://tele.karlson.ru/apk/telefon-latest.apk', '_blank')
}

async function checkAndUpdate() {
  const cur = ($('build-tag')?.textContent || '').replace(/^build\s*/, '').trim()
  let latest = ''
  try {
    const r = await fetch('https://tele.karlson.ru/apk/version.txt?t=' + Date.now())
    latest = (await r.text()).trim()
  } catch { toast('Не удалось проверить обновление', 'error'); return }
  if (!latest) { toast('Версия на сервере не найдена', 'error'); return }
  if (latest === cur) { toast(`Актуальная версия (${cur})`, 'success'); return }
  if (confirm(`Новая версия ${latest} (у вас ${cur}). Скачать и установить?`)) {
    // _system → Capacitor opens it in the external browser / DownloadManager.
    window.open('https://tele.karlson.ru/apk/telefon-latest.apk?t=' + Date.now(), '_system')
  }
}

function manualInstallHint() {
  const ua = navigator.userAgent
  if (/iPhone|iPad|iPod/.test(ua)) {
    return 'Tap Share (⎙), then "Add to Home Screen".'
  }
  if (/Android/.test(ua)) {
    return 'Open browser menu (⋮), tap "Install app" or "Add to Home screen".'
  }
  return 'Open browser menu, tap "Install" (or "Add to Home Screen").'
}

$('btn-install').onclick = async () => {
  if (NATIVE_APP) { await checkAndUpdate(); return }
  if (deferredInstallPrompt) {
    deferredInstallPrompt.prompt()
    await deferredInstallPrompt.userChoice
    deferredInstallPrompt = null
    return
  }
  // Manual route. The browser either hasn't fired beforeinstallprompt yet
  // (engagement heuristics) or doesn't support it at all (iOS Safari,
  // Firefox Android). Show a hint that always works.
  toast(manualInstallHint(), '', 8000)
}

$('btn-share-invite').onclick = async () => {
  const url = buildInviteUrl(client.qrText(nickname || ''))
  try {
    if (navigator.share) {
      await navigator.share({ title: 'ws.tele', text: 'Call me:', url })
    } else {
      await navigator.clipboard.writeText(url)
      toast('Invite link copied', 'success')
    }
  } catch (e) {
    toast(`share failed: ${e}`, 'error')
  }
}

/* =================================== message actions =================================== */

let editingMsgId = null
let msgMenuEl = null
let lastMenuTs = 0  // guards against a long-press also firing img → lightbox

function closeMsgMenu() {
  if (msgMenuEl) { msgMenuEl.remove(); msgMenuEl = null }
}

// Copy a message's text to the clipboard. Native WebView often doesn't pop the
// Android "Copy" action on selection, and free selection grabs surrounding
// chrome (ticks/time), so we offer an explicit menu item that copies just the
// message text.
async function copyMsgText(row) {
  const el = row.querySelector('.msg-text')
  const text = el ? el.textContent : ''
  if (!text) return
  try {
    const Cap = window.Capacitor?.Plugins?.Clipboard
    if (Cap) await Cap.write({ string: text })
    else if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text)
    else {
      const ta = document.createElement('textarea')
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0'
      document.body.appendChild(ta); ta.select()
      document.execCommand('copy'); ta.remove()
    }
    toast('Copied')
  } catch (e) { console.warn('copy failed:', e); toast('Copy failed') }
}

function openMsgMenu(row, x, y) {
  closeMsgMenu()
  lastMenuTs = Date.now()
  const msgId  = row.dataset.id
  const isOut  = row.classList.contains('me')
  const isFile = !!row.querySelector('.msg-file')

  const menu = document.createElement('div')
  menu.className = 'msg-menu'
  const item = (label, fn, cls = '') => {
    const b = document.createElement('button')
    b.className = 'msg-menu-item' + (cls ? ' ' + cls : '')
    b.textContent = label
    b.onclick = (e) => { e.stopPropagation(); closeMsgMenu(); fn() }
    menu.appendChild(b)
  }
  if (isOut && !isFile) item('✏️ Edit', () => enterEditMode(msgId))
  if (!isFile) item('📋 Copy', () => copyMsgText(row))
  item('🗑 Delete', () => openDeleteDialog(msgId, isOut), 'danger')

  document.body.appendChild(menu)
  const r = menu.getBoundingClientRect()
  const px = Math.max(8, Math.min(x, window.innerWidth  - r.width  - 8))
  const py = Math.max(8, Math.min(y, window.innerHeight - r.height - 8))
  menu.style.left = px + 'px'
  menu.style.top  = py + 'px'
  msgMenuEl = menu
  // Close on the next outside interaction.
  setTimeout(() => {
    document.addEventListener('click',       closeMsgMenu, { once: true })
    document.addEventListener('contextmenu', closeMsgMenu, { once: true })
  }, 0)
}

async function enterEditMode(msgId) {
  const rows = await Storage.history(currentPeerId)
  const m = rows.find((r) => r.id === msgId)
  if (!m || isFileRef(m.body)) return
  editingMsgId = msgId
  const inp = $('text-input')
  inp.value = m.body
  inp.focus()
  autoGrowInput()
  $('edit-banner').hidden = false
  renderedMessages.get(msgId)?.classList.add('editing')
}

function cancelEdit() {
  if (editingMsgId) renderedMessages.get(editingMsgId)?.classList.remove('editing')
  editingMsgId = null
  $('text-input').value = ''
  $('edit-banner').hidden = true
  autoGrowInput()
}

// Grow the composer textarea to fit its content up to the CSS max-height
// (then it scrolls internally). Called on input and after programmatic
// value changes (send / edit / cancel).
function autoGrowInput() {
  const ta = $('text-input')
  if (!ta) return
  ta.style.height = 'auto'
  ta.style.height = Math.min(ta.scrollHeight, 120) + 'px'
}
$('text-input').addEventListener('input', autoGrowInput)

// --- Floating "Copy" button for partial text selection ---------------------
// WebView's native selection ActionMode (the system Copy bar) is unreliable, so
// when the user selects a chunk of message text we pop our own Copy button
// above the selection. Lets people grab a link / phone / address out of a bubble.
let _selCopyBtn = null
function _ensureSelCopyBtn() {
  if (_selCopyBtn) return _selCopyBtn
  const b = document.createElement('button')
  b.className = 'sel-copy-btn'
  b.textContent = '📋 Copy'
  b.style.display = 'none'
  // Don't let the press clear the selection before the click handler runs.
  b.addEventListener('mousedown', (e) => e.preventDefault())
  b.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false })
  b.addEventListener('click', async () => {
    const t = (window.getSelection() || '').toString()
    if (t && t.trim()) {
      try {
        if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(t)
        else document.execCommand('copy')
        toast('Copied')
      } catch (e) { console.warn('copy failed', e); toast('Copy failed') }
    }
    b.style.display = 'none'
    window.getSelection()?.removeAllRanges?.()
  })
  document.body.appendChild(b)
  _selCopyBtn = b
  return b
}
function _updateSelCopyBtn() {
  const sel = window.getSelection()
  const b = _ensureSelCopyBtn()
  const txt = sel ? sel.toString() : ''
  if (!txt || !txt.trim() || sel.rangeCount === 0) { b.style.display = 'none'; return }
  // Only when the selection sits inside chat message text.
  const node = sel.anchorNode
  const host = node && (node.nodeType === 1 ? node : node.parentElement)
  if (!host || !host.closest || !host.closest('.msg-text')) { b.style.display = 'none'; return }
  const rect = sel.getRangeAt(0).getBoundingClientRect()
  if (!rect || (rect.width === 0 && rect.height === 0)) { b.style.display = 'none'; return }
  b.style.display = 'block'
  b.style.left = (rect.left + rect.width / 2) + 'px'
  let top = rect.top - 42
  if (top < 6) top = rect.bottom + 8   // flip below if no room above
  b.style.top = top + 'px'
}
document.addEventListener('selectionchange', () => {
  clearTimeout(_updateSelCopyBtn._t)            // selectionchange fires rapidly while dragging
  _updateSelCopyBtn._t = setTimeout(_updateSelCopyBtn, 120)
})
document.addEventListener('scroll', () => {     // position would go stale on scroll
  if (_selCopyBtn) _selCopyBtn.style.display = 'none'
}, true)

function openDeleteDialog(msgId, isOut) {
  closeMsgMenu()
  const overlay = document.createElement('div')
  overlay.className = 'dialog'
  const close = () => overlay.remove()

  const doDelete = async (forEveryone) => {
    if (forEveryone && currentPeerId) {
      const peerId = hexU8(currentPeerId)
      client.introduce(peerId, nickname || '')
      client.sendMsgDelete(peerId, msgId)
    }
    await Storage.deleteMessage(msgId)
    removeMessageRow(msgId)
    close()
  }

  const box = document.createElement('div')
  box.className = 'dialog-box'
  const title = document.createElement('div')
  title.className = 'dialog-title'; title.textContent = 'Delete message?'
  box.appendChild(title)

  const btns = document.createElement('div')
  btns.className = 'dialog-buttons'; btns.style.flexWrap = 'wrap'
  const mkBtn = (label, cls, fn) => {
    const b = document.createElement('button'); b.className = cls; b.textContent = label; b.onclick = fn
    btns.appendChild(b)
  }
  mkBtn('Cancel', 'secondary', close)
  mkBtn('Delete for me', 'danger', () => doDelete(false))
  if (isOut) mkBtn('Delete for everyone', 'danger', () => doDelete(true))
  box.appendChild(btns)
  overlay.appendChild(box)
  overlay.onclick = (e) => { if (e.target === overlay) close() }
  document.body.appendChild(overlay)
}

// Desktop convenience: right-click a message also opens the action menu.
// Touch uses the explicit ⋮ handle (no long-press) so native text selection
// keeps working — long-press on the text selects/copies as usual.
$('chat').addEventListener('contextmenu', (e) => {
  const row = e.target.closest('.msg')
  if (!row || !row.dataset.id) return
  e.preventDefault()
  openMsgMenu(row, e.clientX, e.clientY)
})

$('edit-cancel').onclick = cancelEdit

$('btn-clear-history').onclick = () => {
  if (!currentPeerId) return
  const peer = peerBook[currentPeerId]
  const name = peer?.label || currentPeerId.slice(0, 8)
  const overlay = document.createElement('div')
  overlay.className = 'dialog'
  const close = () => overlay.remove()
  overlay.innerHTML = `
    <div class="dialog-box">
      <div class="dialog-title">Clear history?</div>
      <div class="dialog-text">Delete the entire conversation with ${escapeHtml(name)} on this device. This cannot be undone and does not affect the other side.</div>
    </div>`
  const btns = document.createElement('div')
  btns.className = 'dialog-buttons'
  const cancel = document.createElement('button'); cancel.className = 'secondary'; cancel.textContent = 'Cancel'; cancel.onclick = close
  const ok = document.createElement('button'); ok.className = 'danger'; ok.textContent = 'Clear'
  ok.onclick = async () => {
    await Storage.clearHistory(currentPeerId)
    cancelEdit()
    if (searchActive) await closeSearch()
    else await refreshChat()
    close()
  }
  btns.appendChild(cancel); btns.appendChild(ok)
  overlay.querySelector('.dialog-box').appendChild(btns)
  overlay.onclick = (e) => { if (e.target === overlay) close() }
  document.body.appendChild(overlay)
}

/* =================================== chat search =================================== */

// Search mode swaps the normal windowed chat for a flat list of matching
// messages, with the matched fragment highlighted. Leaving search (✕ / Escape
// / empty query) restores the normal windowed view via refreshChat().

let searchDebounce = null

function openSearch() {
  if (!currentPeerId) return
  searchActive = true
  $('search-bar').hidden = false
  $('search-input').value = ''
  $('search-info').textContent = ''
  $('search-input').focus()
}

async function closeSearch() {
  if (!searchActive) return
  searchActive = false
  $('search-bar').hidden = true
  $('search-info').textContent = ''
  clearTimeout(searchDebounce)
  // Back to the normal windowed conversation, pinned to the bottom.
  await refreshChat()
}

async function runSearch(query) {
  if (!searchActive || !currentPeerId) return
  const q = query.trim()
  const box = $('chat')
  if (!q) {
    // Empty field: clear results but stay in search mode (don't reload chat).
    box.innerHTML = ''
    renderedMessages.clear()
    $('search-info').textContent = ''
    return
  }
  const rows = await Storage.search(currentPeerId, q)
  box.innerHTML = ''
  renderedMessages.clear()
  for (const m of rows) box.appendChild(renderSearchHit(m, q))
  $('search-info').textContent = rows.length
    ? `${rows.length} found`
    : 'Nothing found'
  // Results read top-down, newest at the bottom — show the start of the list.
  box.scrollTop = 0
}

// Like renderTextMessage, but highlights every case-insensitive occurrence of
// `query` with <mark>. URLs are still linkified; highlight is applied only to
// the plain-text spans so anchors stay intact.
function renderSearchHit(m, query) {
  const row = makeMsgShell(m)
  const text = document.createElement('span')
  text.className = 'msg-text'
  highlightLinkifyInto(text, m.body, query)
  row.insertBefore(text, row.firstChild)
  return row
}

// Render `body` into `span`: linkify bare URLs (as anchors) and wrap matches
// of `query` in plain-text segments with <mark>. Reuses URL_RE so link
// detection stays identical to the normal renderer.
function highlightLinkifyInto(span, body, query) {
  let last = 0
  for (const match of body.matchAll(URL_RE)) {
    const raw = match[0]
    const url = trimTrailingPunct(raw)
    const start = match.index
    if (start > last) appendHighlighted(span, body.slice(last, start), query)
    const a = document.createElement('a')
    a.className = 'msg-link'
    a.href = url
    a.target = '_blank'
    a.rel = 'noopener noreferrer'
    a.textContent = url
    span.appendChild(a)
    last = start + url.length
  }
  if (last < body.length) appendHighlighted(span, body.slice(last), query)
}

// Append `text` to `span`, wrapping each case-insensitive `query` hit in <mark>.
function appendHighlighted(span, text, query) {
  const q = query.toLowerCase()
  const hay = text.toLowerCase()
  let from = 0
  let idx = hay.indexOf(q)
  while (idx !== -1) {
    if (idx > from) span.appendChild(document.createTextNode(text.slice(from, idx)))
    const mark = document.createElement('mark')
    mark.textContent = text.slice(idx, idx + q.length)
    span.appendChild(mark)
    from = idx + q.length
    idx = hay.indexOf(q, from)
  }
  if (from < text.length) span.appendChild(document.createTextNode(text.slice(from)))
}

$('btn-search').onclick = () => { searchActive ? closeSearch() : openSearch() }
$('search-close').onclick = () => closeSearch()
$('search-input').addEventListener('input', (e) => {
  const q = e.target.value
  clearTimeout(searchDebounce)
  searchDebounce = setTimeout(() => runSearch(q), 200)
})
$('search-input').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.preventDefault(); closeSearch() }
})

/* =================================== call-screen wiring =================================== */

$('btn-back').onclick = () => {
  call.hangup()
  currentPeerId = null
  showScreen('contacts')
  // Pop our synthetic history entry so back/forward stays consistent.
  if (history.state?.screen === 'call') history.back()
}
$('call-btn').onclick = () => {
  if (!currentPeerId) return
  const peerId = hexU8(currentPeerId)
  // Re-introduce ourselves first so the callee can decrypt our CALL_REQUEST
  // even if they don't yet have our keys (e.g. they were offline when the
  // initial INTRODUCE was sent right after we added their QR).
  client.introduce(peerId, nickname || '')
  call.call(peerId)
  playOutgoing()
  // Push-wake an offline callee so a backgrounded app can ring.
  maybeWake(currentPeerId, true)  // true = call → ringtone push
}
$('hangup-btn').onclick = () => call.hangup()
$('switch-cam').onclick = () => call.switchCamera()
$('mute-btn').onclick   = () => {
  const muted = call.toggleMute()
  $('mute-btn').textContent = muted ? '🎤 Mic off' : '🔇 Mic'
}
$('video-btn').onclick = () => {
  const off = call.toggleVideo()
  $('video-btn').textContent = off ? '📷 Video off' : '🎥 Video'
}
$('res-select').onchange = () => {
  call.setVideoResolution(parseInt($('res-select').value, 10))
}

/* Camera / microphone pickers — appear during a call when more than one
 * device of a kind is present. Switching replaces the corresponding track
 * in the live RTCPeerConnection without renegotiating. */
async function populateDeviceSelectors() {
  let devs
  try { devs = await call.listDevices() } catch { return }
  fillDeviceSelect($('cam-select'), devs.videoInputs, 'Camera')
  fillDeviceSelect($('mic-select'), devs.audioInputs, 'Microphone')
}

function fillDeviceSelect(sel, list, kindLabel) {
  const prev = sel.value
  sel.innerHTML = ''
  list.forEach((d, i) => {
    const opt = document.createElement('option')
    opt.value = d.deviceId
    opt.textContent = d.label || `${kindLabel} ${i + 1}`
    sel.appendChild(opt)
  })
  // Restore the previous selection if it still exists in the new list.
  if (list.some(d => d.deviceId === prev)) sel.value = prev
  // A single (or zero) device makes the picker pointless — hide it.
  sel.hidden = list.length < 2
}

$('cam-select').onchange = () => {
  call.setVideoInput($('cam-select').value)
}
$('mic-select').onchange = () => {
  call.setAudioInput($('mic-select').value)
}

/* speaker toggle — earpiece vs loudspeaker (where the browser exposes
 *  setSinkId on media elements). We probe device list once on first
 *  click and cycle through the available audiooutputs. */
let speakerCycle = null
let speakerIdx = 0
$('speaker-btn').onclick = async () => {
  try {
    if (!speakerCycle) {
      const devs = await navigator.mediaDevices.enumerateDevices()
      speakerCycle = devs.filter(d => d.kind === 'audiooutput')
      if (speakerCycle.length === 0) { toast('no audio outputs', 'error'); return }
    }
    speakerIdx = (speakerIdx + 1) % speakerCycle.length
    const dev = speakerCycle[speakerIdx]
    await call.setAudioSink(dev.deviceId)
    const labelGuess = /speaker|loudspeaker/i.test(dev.label) ? '🔊 Loud'
                     : /earpiece|receiver/i.test(dev.label)   ? '🎧 Earpiece'
                     : '🔊 ' + (dev.label || 'output')
    $('speaker-btn').textContent = labelGuess
    toast(dev.label || dev.deviceId, 'success')
  } catch (e) {
    toast(`audio sink: ${e.message}`, 'error')
  }
}
$('send-text').onclick = async () => {
  if (!currentPeerId) return
  const text = $('text-input').value.trim()
  if (!text) return
  const peerId = hexU8(currentPeerId)

  // Edit mode: replace an existing message instead of creating a new one.
  if (editingMsgId) {
    const id = editingMsgId
    const ok = await Storage.editMessage(id, text)
    if (ok) {
      updateMessageBody(id, text)
      // Best-effort push to the peer; harmless if they're offline.
      client.introduce(peerId, nickname || '')
      client.sendMsgEdit(peerId, id, text)
    }
    cancelEdit()
    return
  }

  // Sending while searching: drop back to the live conversation so the new
  // message lands in (and the user sees) the normal view, not the result list.
  if (searchActive) await closeSearch()

  // Persist first so the message survives a refresh / offline retry.
  const msgId = await Storage.saveOutgoing(currentPeerId, text)
  appendChatRow({ id: msgId, dir: 'out', body: text, status: 'pending' })
  $('chat').scrollTop = $('chat').scrollHeight
  $('text-input').value = ''
  autoGrowInput()
  // Make sure recipient has our keys, then send. If WS is down the
  // outbox entry stays and we retry on PEER_ONLINE.
  client.introduce(peerId, nickname || '')
  const ok = client.sendText(peerId, msgId, text)
  if (ok) {
    await Storage.markStatus(msgId, 'sent')
    updateRowStatus(msgId, 'sent')
  }
  // If the recipient is offline, nudge the server to push-wake them.
  maybeWake(currentPeerId)
}

/* =================================== file send =================================== */

$('attach-btn').onclick = () => $('file-input').click()
$('file-input').onchange = async (e) => {
  const files = Array.from(e.target.files || [])
  e.target.value = ''
  for (const file of files) await sendFile(file)
}

async function sendFile(file) {
  if (!currentPeerId) { toast('No peer selected', 'error'); return }
  const peerId = hexU8(currentPeerId)
  const fileId = crypto.randomUUID()
  const msgId  = crypto.randomUUID()

  // Read once into memory. For files up to a few tens of MB this is OK;
  // larger files would need streaming reads but it'd be wasteful UX too.
  const buf = new Uint8Array(await file.arrayBuffer())

  // Image thumbnail — small JPEG so the offer frame stays well under 1 MB.
  let thumb_b64 = null
  if (file.type.startsWith('image/')) {
    try { thumb_b64 = await makeThumb(file) } catch {}
  }

  const meta = { id: fileId, name: file.name, mime: file.type || 'application/octet-stream', size: file.size, thumb_b64 }
  await Storage.saveFileMeta({ ...meta, thumb_blob: thumb_b64 ? blobFromB64(thumb_b64, 'image/jpeg') : null })
  await Storage.saveFileBlob(fileId, file)  // we already have the blob locally
  await DB.add('telefon.lleo.me', 'messages', {
    id: msgId, peer_id: currentPeerId, dir: 'out',
    body: `%${fileId}`, ts: Date.now(), status: 'pending',
  })
  await DB.add('telefon.lleo.me', 'outbox', { id: msgId, attempts: 0, last_try_ts: 0 })

  // Render the bubble locally first.
  const row = await renderFileMessage({ id: msgId, dir: 'out', body: `%${fileId}`, status: 'pending' })
  $('chat').appendChild(row)
  $('chat').scrollTop = $('chat').scrollHeight

  // Push offer + chunks + end.
  client.introduce(peerId, nickname || '')
  client.sendFileOffer(peerId, meta)
  const total = Math.ceil(buf.length / CHUNK_BYTES) || 1
  for (let i = 0; i < total; i++) {
    // Backpressure: don't outrun the socket's send buffer. Over TLS in a
    // WebView, blasting all chunks synchronously overflows the buffer and
    // frames get dropped (file never reassembles). Wait for it to drain.
    let guard = 0
    while (client.ws && client.ws.bufferedAmount > 256 * 1024 && guard++ < 500) {
      await new Promise((r) => setTimeout(r, 20))
    }
    const slice = buf.subarray(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES)
    const ok = client.sendFileChunk(peerId, fileId, i, slice)
    if (!ok) {
      // socket dropped mid-stream; leave outbox entry pending, retry on PEER_ONLINE
      return
    }
  }
  client.sendFileEnd(peerId, fileId, msgId)
  await Storage.markStatus(msgId, 'sent')
  updateRowStatus(msgId, 'sent')
  // If the recipient is offline, nudge the server to push-wake them.
  maybeWake(currentPeerId)
}

function makeThumb(file) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      const max = 200
      const ratio = Math.min(1, max / Math.max(img.width, img.height))
      const w = Math.round(img.width * ratio), h = Math.round(img.height * ratio)
      const cv = document.createElement('canvas')
      cv.width = w; cv.height = h
      cv.getContext('2d').drawImage(img, 0, 0, w, h)
      cv.toBlob((b) => {
        const r = new FileReader()
        r.onloadend = () => resolve(r.result.split(',')[1])
        r.readAsDataURL(b)
      }, 'image/jpeg', 0.7)
    }
    img.onerror = reject
    img.src = URL.createObjectURL(file)
  })
}

function blobFromB64(b64, mime) {
  const bin = atob(b64)
  const u8 = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i)
  return new Blob([u8], { type: mime })
}

/** Drain everything pending for `peerId` over the live WS. */
async function flushOutboxFor(peerIdHex) {
  const pending = await Storage.pendingFor(peerIdHex)
  if (pending.length === 0) return
  const peerId = hexU8(peerIdHex)
  // Re-introduce in case the peer just woke up without us.
  client.introduce(peerId, nickname || '')
  for (const m of pending) {
    if (!isFileRef(m.body)) {
      const ok = client.sendText(peerId, m.id, m.body)
      if (ok) {
        await Storage.markStatus(m.id, 'sent')
        updateRowStatus(m.id, 'sent')
      } else {
        await Storage.bumpAttempt(m.id)
        break  // socket down — stop, try again on next PEER_ONLINE
      }
    }
  }
}
// Enter inserts a newline (textarea default); sending is ONLY via the send
// button — per Leo's explicit preference. Deliberately no Enter-to-send.

/* =================================== stats overlay =================================== */

let statsTimer = null
async function refreshStats() {
  const ov = $('stats-overlay')
  const s = await call.getStats()
  if (!s) { ov.textContent = '(no active session)'; return }
  const path = `${s.local} → ${s.remote}`
  const link = s.local === 'relay' || s.remote === 'relay' ? 'via TURN' : 'direct'
  ov.textContent =
    `path:  ${path}  (${link})\n` +
    `proto: ${s.protocol}  rtt: ${s.rttMs} ms\n` +
    `tx:    ${String(s.kbpsSent).padStart(4)} kbps  ${s.codecVideo}/${s.codecAudio}\n` +
    `rx:    ${String(s.kbpsReceived).padStart(4)} kbps`
}
function showStatsOverlay() {
  $('stats-overlay').hidden = false
  refreshStats()
  statsTimer = setInterval(refreshStats, 1000)
}
function hideStatsOverlay() {
  if (statsTimer) { clearInterval(statsTimer); statsTimer = null }
  $('stats-overlay').hidden = true
}
$('stats-toggle').onclick = () => {
  if ($('stats-overlay').hidden) showStatsOverlay()
  else hideStatsOverlay()
}

function hexU8(hex) {
  const m = hex.match(/.{1,2}/g) || []
  return new Uint8Array(m.map(b => parseInt(b, 16)))
}

/* =================================== draggable PiP =================================== */

// Make the local mini-preview (#my-video) draggable inside the video stage so
// it can be moved off the remote person's face. Pointer Events cover both
// touch and mouse. Position is kept in JS for the session (not persisted).
function initDraggablePip() {
  const pip = $('my-video')
  const stage = document.querySelector('.video-stage')
  if (!pip || !stage) return

  const DRAG_THRESHOLD = 5  // px; below this it's a tap, not a drag
  let dragging = false
  let moved = false
  let startX = 0, startY = 0          // pointer position at pointerdown
  let baseLeft = 0, baseTop = 0       // pip top-left at pointerdown (stage-relative)
  let activePointer = null

  const clamp = (v, min, max) => Math.max(min, Math.min(max, v))

  // Convert the current right/bottom anchoring to left/top so we can move it
  // freely. Coordinates are relative to the stage's content box.
  function switchToLeftTop() {
    const s = stage.getBoundingClientRect()
    const p = pip.getBoundingClientRect()
    const left = p.left - s.left
    const top  = p.top  - s.top
    pip.style.left = left + 'px'
    pip.style.top  = top + 'px'
    pip.style.right = 'auto'
    pip.style.bottom = 'auto'
    return { left, top }
  }

  pip.addEventListener('pointerdown', (e) => {
    // Establish a left/top baseline (handles the initial right/bottom anchor
    // and re-anchors after the stage was re-shown / resized).
    const pos = switchToLeftTop()
    baseLeft = pos.left
    baseTop  = pos.top
    startX = e.clientX
    startY = e.clientY
    dragging = true
    moved = false
    activePointer = e.pointerId
    pip.setPointerCapture(e.pointerId)
  })

  pip.addEventListener('pointermove', (e) => {
    if (!dragging || e.pointerId !== activePointer) return
    const dx = e.clientX - startX
    const dy = e.clientY - startY
    if (!moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return  // still a tap
    moved = true
    pip.classList.add('dragging')
    const s = stage.getBoundingClientRect()
    const maxLeft = s.width  - pip.offsetWidth
    const maxTop  = s.height - pip.offsetHeight
    pip.style.left = clamp(baseLeft + dx, 0, Math.max(0, maxLeft)) + 'px'
    pip.style.top  = clamp(baseTop  + dy, 0, Math.max(0, maxTop))  + 'px'
    e.preventDefault()
  })

  const endDrag = (e) => {
    if (!dragging || (activePointer !== null && e.pointerId !== activePointer)) return
    dragging = false
    activePointer = null
    pip.classList.remove('dragging')
    try { pip.releasePointerCapture(e.pointerId) } catch {}
  }
  pip.addEventListener('pointerup', endDrag)
  pip.addEventListener('pointercancel', endDrag)
}

/* =================================== settings dialog =================================== */

// ── Settings window (lui) ────────────────────────────────────────────────────
// The legacy #dialog-settings markup in index.html is no longer opened; the
// settings UI is now a lui window built on demand. We keep the hidden #import-file
// input around because the import flow reuses it.

// Smart default WebSocket URL. In the native APK we want plain ws:// (the WebView
// runs on https://localhost but cleartext is allowed via the manifest, and the
// public relay is reachable over ws); in a browser we must match the page scheme
// (https → wss, otherwise the browser blocks mixed content).
function smartDefaultUrl() {
  const base = SRV_DEFAULTS.url            // e.g. wss://tele.karlson.ru/ws
  const rest = base.replace(/^wss?:\/\//, '')
  if (NATIVE_APP) return 'ws://' + rest
  return (location.protocol === 'https:' ? 'wss://' : 'ws://') + rest
}

// Build a plain-text contacts export and trigger a download.
function exportContacts() {
  const stored = loadPeers()
  const lines = []
  for (const [id, p] of Object.entries(stored)) {
    if (!p?.qr) continue
    const label = (p.label || '').replace(/[\r\n\t]/g, ' ')
    lines.push(`${id} ${p.qr}${label ? ' ' + label : ''}`)
  }
  const blob = new Blob([lines.join('\n') + (lines.length ? '\n' : '')], { type: 'text/plain' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = 'ws-tele-contacts.txt'
  a.click()
  URL.revokeObjectURL(a.href)
}

$('import-file').onchange = async (e) => {
  const file = e.target.files[0]
  if (!file) return
  try {
    const text = await file.text()
    let imported = 0
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim()
      if (!line || line.startsWith('#')) continue
      // split into 3 tokens: id, qr, optional label (rest of line, may contain spaces)
      const m = line.match(/^(\S+)\s+(\S+)(?:\s+(.+))?$/)
      if (!m) continue
      const [, idHex, qr, label] = m
      if (!qr.startsWith('K0')) continue
      try {
        const idU8 = client.addPeerFromQr(qr)
        const realId = u8hex(idU8)
        peerBook[realId] = { qr, label: label?.trim() || null, online: false }
        imported++
      } catch { /* skip bad entries */ }
    }
    persist()
    renderContacts()
    subscribeAll()
    toast(`imported: ${imported}`, 'success')
  } catch (e2) {
    toast(`import failed: ${e2}`, 'error')
  }
  e.target.value = ''
}

function wipeIdentity() {
  ;(async () => {
    await Storage.wipe()
    wipeSeeds()
    wipeNickname()
    savePeers({})
    location.reload()
  })()
}

// Open the settings window. Built fresh each time so it shows current values.
function openSettings() {
  const lui = window.lui
  const cur = serverConfig()
  const curUrl   = cur.url   || smartDefaultUrl()
  const curXpub  = cur.xpub  || SRV_DEFAULTS.xpub
  const curEdpub = cur.edpub || SRV_DEFAULTS.edpub
  const invite   = buildInviteUrl(client.qrText(nickname || ''))
  const idLine   = `id: ${u8hex(client.myId)}`
  const themeNow = lui.theme()                 // 'auto' | 'light' | 'dark'
  const langNow  = lui.lang()                  // 'en' | 'ru' | 'uk'
  const fxNow    = lui.setEffects()            // boolean
  const verNow   = ($('build-tag')?.textContent || '').replace(/^build\s*/, '').trim() || '—'

  const html = `
    <div class="set-sec">
      <h3>Моё имя</h3>
      <div class="set-row">
        <input id="set-name" class="input" type="text" maxlength="40" placeholder="ваше имя" data-nopersist />
        <button id="set-name-save" class="btn btn-primary">OK</button>
      </div>
    </div>

    <div class="set-sec">
      <h3>Мой invite</h3>
      <input id="set-invite" class="input" type="text" readonly data-nopersist />
      <div class="set-row" style="margin-top:8px">
        <button id="set-copy"   class="btn btn-ghost">Копировать</button>
        <button id="set-export" class="btn btn-ghost">Экспорт контактов</button>
        <button id="set-import" class="btn btn-ghost">Импорт контактов</button>
      </div>
      <div class="muted" id="set-id" style="margin-top:8px"></div>
    </div>

    <div class="set-sec">
      <h3>Внешний вид</h3>
      <div class="set-row" style="justify-content:space-between">
        <span>Тема</span>
        <span class="select">
          <select id="set-theme" data-nopersist>
            <option value="auto">Авто</option>
            <option value="light">Светлая</option>
            <option value="dark">Тёмная</option>
          </select>
        </span>
      </div>
      <div class="set-row" style="justify-content:space-between; margin-top:12px">
        <span>Язык</span>
        <span class="select">
          <select id="set-lang" data-nopersist>
            <option value="ru">Русский</option>
            <option value="en">English</option>
            <option value="uk">Українська</option>
          </select>
        </span>
      </div>
      <div class="set-row" style="justify-content:space-between; margin-top:12px">
        <span>Эффекты (анимации, звук, вибро)</span>
        <label class="toggle">
          <input id="set-fx" type="checkbox" data-nopersist />
          <span class="track"></span>
        </label>
      </div>
    </div>

    <div class="set-sec">
      <h3>Сервер</h3>
      <input id="set-url" class="input" type="text" placeholder="wss://your-server/ws" data-nopersist />
      <div class="set-row" style="margin-top:8px">
        <button id="set-srv-save"  class="btn btn-primary">Сохранить и перезапустить</button>
        <button id="set-srv-reset" class="btn btn-ghost">Сбросить к дефолту</button>
      </div>
      <details class="set-adv">
        <summary>Расширенное</summary>
        <label class="muted">Server X25519 pub (hex)</label>
        <input id="set-xpub"  class="input" type="text" placeholder="64 hex chars" data-nopersist />
        <label class="muted">Server Ed25519 pub (hex)</label>
        <input id="set-edpub" class="input" type="text" placeholder="64 hex chars" data-nopersist />
      </details>
    </div>

    <div class="set-sec">
      <h3>Обновление</h3>
      <div class="set-row" style="justify-content:space-between">
        <span class="muted">Версия ${escapeHtml(verNow)}</span>
        <button id="set-update" class="btn btn-ghost">Проверить обновление</button>
      </div>
    </div>

    <details class="set-sec set-danger">
      <summary>Опасная зона</summary>
      <p class="muted set-danger-note">Полностью стирает ключи, контакты и историю. Отменить нельзя — друзья перестанут вас узнавать.</p>
      <a id="set-wipe" class="set-wipe-link" role="button" tabindex="0">Wipe identity</a>
    </details>`

  const w = lui.win('Настройки', html)
  const q = (sel) => w.querySelector(sel)

  // Prefill values.
  q('#set-name').value   = nickname || ''
  q('#set-invite').value = invite
  q('#set-id').textContent = idLine
  q('#set-theme').value  = themeNow
  q('#set-lang').value   = langNow
  q('#set-fx').checked   = !!fxNow
  q('#set-url').value    = curUrl
  q('#set-xpub').value   = curXpub
  q('#set-edpub').value  = curEdpub

  // ── My name ──
  q('#set-name-save').onclick = () => {
    const v = q('#set-name').value.trim()
    if (!v) { toast('Name cannot be empty', 'error'); return }
    nickname = v
    saveNickname(v)
    $('my-nickname').textContent = v
    q('#set-invite').value = buildInviteUrl(client.qrText(nickname))
    lui.toast('Name updated')
  }

  // ── Invite / contacts ──
  q('#set-copy').onclick = async () => {
    try { await navigator.clipboard.writeText(q('#set-invite').value) } catch {}
    lui.toast(lui.t('copied'))
  }
  q('#set-export').onclick = () => exportContacts()
  q('#set-import').onclick = () => $('import-file').click()

  // ── Appearance ──
  q('#set-theme').onchange = (e) => lui.theme(e.target.value)
  q('#set-lang').onchange  = (e) => lui.lang(e.target.value)
  q('#set-fx').onchange    = (e) => lui.setEffects(e.target.checked)

  // ── Server config ──
  q('#set-srv-save').onclick = () => {
    const url = q('#set-url').value.trim()
    const xp  = q('#set-xpub').value.trim().toLowerCase()
    const ep  = q('#set-edpub').value.trim().toLowerCase()
    if (xp && !/^[0-9a-f]{64}$/.test(xp)) { toast('X-pub: нужно 64 hex-символа', 'error'); return }
    if (ep && !/^[0-9a-f]{64}$/.test(ep)) { toast('Ed-pub: нужно 64 hex-символа', 'error'); return }
    const dUrl = smartDefaultUrl()
    // Only persist values that differ from the (smart) default — keep storage clean.
    url && url !== dUrl               ? localStorage.setItem('telefon_ws_url', url)   : localStorage.removeItem('telefon_ws_url')
    xp  && xp  !== SRV_DEFAULTS.xpub  ? localStorage.setItem('telefon_srv_xpub', xp)  : localStorage.removeItem('telefon_srv_xpub')
    ep  && ep  !== SRV_DEFAULTS.edpub ? localStorage.setItem('telefon_srv_edpub', ep) : localStorage.removeItem('telefon_srv_edpub')
    toast('Сохранено, перезапуск…', 'success')
    setTimeout(() => location.reload(), 600)
  }
  q('#set-srv-reset').onclick = () => {
    localStorage.removeItem('telefon_ws_url')
    localStorage.removeItem('telefon_srv_xpub')
    localStorage.removeItem('telefon_srv_edpub')
    toast('Сброшено на сервер по умолчанию, перезапуск…', 'success')
    setTimeout(() => location.reload(), 600)
  }

  // ── Update ──
  q('#set-update').onclick = () => checkAndUpdate()

  // ── Wipe identity (guarded by lui.confirm) ──
  const askWipe = () => {
    lui.confirm({
      icon: '🗑️',
      title: 'Wipe identity?',
      text: 'All contacts AND chat history will be lost — your friends will no longer recognise you.',
      danger: true,
      ok: 'Wipe',
      cancel: lui.t('cancel'),
    }, wipeIdentity)
  }
  q('#set-wipe').onclick = askWipe
  q('#set-wipe').onkeydown = (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); askWipe() }
  }
}

$('btn-settings').onclick = openSettings

/* =================================== final wiring =================================== */

// Make the local mini-preview draggable within the video stage.
initDraggablePip()
