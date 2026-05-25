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

/* =================================== i18n =================================== */

// Shorthand around lui's translator (current → en → key). All telefon strings
// live in i18n.js, registered into lui's dictionary for every supported language.
const t = (key, vars) => window.lui.t(key, vars)

// Apply the current language to every tagged node under `root`:
//   data-i18n        → textContent
//   data-i18n-ph     → placeholder
//   data-i18n-title  → title
//   data-i18n-aria   → aria-label
// Called once at startup and again on every 'lui:lang' change for live switching.
function applyI18n(root = document) {
  root.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n) })
  root.querySelectorAll('[data-i18n-ph]').forEach((el) => { el.placeholder = t(el.dataset.i18nPh) })
  root.querySelectorAll('[data-i18n-title]').forEach((el) => { el.title = t(el.dataset.i18nTitle) })
  root.querySelectorAll('[data-i18n-aria]').forEach((el) => { el.setAttribute('aria-label', t(el.dataset.i18nAria)) })
}

// Live language switch: re-translate the static page, then re-apply the few
// dynamic labels that don't ride on a plain data-i18n node (install/update
// button and the live connection-status pill).
window.addEventListener('lui:lang', () => {
  applyI18n()
  refreshConnText()
})

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

/* ── Call log (debug + visibility) ───────────────────────────────────────────
 * A small persisted ring-buffer of call events so a ring is never a mystery:
 * you can always see who/what/when. Events: incoming, accepted, declined,
 * missed (rang out), dup (duplicate/replayed request ignored), outgoing,
 * connected, ended. Viewer lives in Settings → Call log. */
const CALL_LOG_KEY = 'telefon_call_log'
function loadCallLog() { try { return JSON.parse(localStorage.getItem(CALL_LOG_KEY)) || [] } catch { return [] } }
function logCall(ev, idHex, note) {
  try {
    const log = loadCallLog()
    const name = (idHex && peerBook[idHex]?.label) || (idHex ? idHex.slice(0, 8) : '')
    log.push({ t: Date.now(), ev, id: idHex || '', name, note: note || '' })
    while (log.length > 80) log.shift()
    localStorage.setItem(CALL_LOG_KEY, JSON.stringify(log))
  } catch {}
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

// In-flight delivery tracking for text messages. We send the TEXT alone (no
// INTRODUCE) on every send; only if a message isn't delivery-acked while the
// socket is alive do we assume the recipient lacks our keys and resend with an
// INTRODUCE. msgId -> { peerId:Uint8Array, nick, text, retried:boolean, timer }.
const pendingDelivery = new Map()
const DELIVERY_WATCHDOG_MS = 5000

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
      <div class="name">${escapeHtml(c.label || t('unnamed'))}</div>
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
    // Tapping the orange avatar circle starts a CALL directly (not the chat).
    const avatar = li.querySelector('.avatar')
    if (avatar) {
      avatar.title = t('call')
      avatar.style.cursor = 'pointer'
      avatar.onclick = (e) => {
        e.stopPropagation()                              // don't also open the chat
        if (Date.now() - lastContactMenuTs < 600) return
        startOutgoingCall(c.id)
      }
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
  item(t('rename'), () => openRenameDialog(idHex))
  item(t('copy_contact'), () => copyContact(idHex))
  item(t('clear_chat'), () => clearContactChat(idHex))
  item(t('ban'), () => banContact(idHex), 'danger')
  item(t('del_contact'), () => openDeleteContactDialog(idHex), 'danger')

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

// Copy this contact's invite link — same shape as settings → "share my invite",
// but for the selected peer (so you can hand someone else's contact to a third party).
function copyContact(idHex) {
  const p = peerBook[idHex]
  if (!p || !p.qr) return
  window.lui.copy(buildInviteUrl(p.qr))
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
  $('delete-contact-text').textContent = t('del_contact_text_named', { name })
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
    toast(t('deleted', { name }), 'success')
  }
}

// Erase only the conversation with a contact (history + files), keeping the
// contact itself. Guarded by a confirm; refreshes the open chat if it's this peer.
function clearContactChat(idHex) {
  const p = peerBook[idHex]
  if (!p) return
  const name = p.label || idHex.slice(0, 8)
  window.lui.confirm({
    icon: '🧹', title: t('clear_history_title'), text: t('clear_history_text', { name }),
    danger: true, ok: t('clear'), cancel: t('cancel'),
  }, async () => {
    try { await Storage.clearHistory(idHex) } catch (e) { console.warn('clearHistory', e) }
    clearUnread(idHex)
    if (currentPeerId === idHex) await refreshChat()
  })
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' }[c]))
}

/* =================================== INTRO_FROM handler =================================== */

// A contact's "type" (person / claude / device / service / sim …) rides in the
// introduced nickname as an optional "name␟type" tag (␟ = U+241F unit separator),
// so it travels without changing the wire/QR format. Absent tag = person (we
// simply don't store a type — per the agreed model where person = no type field).
const NICK_TYPE_SEP = '␟'
function splitNickType(raw) {
  const s = String(raw || '')
  const i = s.indexOf(NICK_TYPE_SEP)
  if (i < 0) return { name: s, type: null }
  const type = s.slice(i + 1).trim().toLowerCase()
  return { name: s.slice(0, i), type: (type && type !== 'person') ? type : null }
}

function handleIntroFrom(body) {
  if (body.length < 64) return
  const x_pub  = body.slice(0, 32)
  const ed_pub = body.slice(32, 64)
  const { name: nick, type: introType } = splitNickType(new TextDecoder().decode(body.slice(64)))
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
  // A blacklisted peer introducing itself again must NOT be re-added to the
  // contact list — drop the intro before it touches peerBook.
  if (isBanned(idHex)) return
  const wasNew = !peerBook[idHex]
  // Preserve any local nickname if the user already named this peer; only
  // adopt the introduced nickname for fresh entries.
  const entry = {
    qr,
    label: peerBook[idHex]?.label || nick || null,
    online: true,  // they're online, that's how they just introduced themselves
  }
  // Keep an existing type, else adopt the introduced one. Absent = person.
  const ty = peerBook[idHex]?.type || introType
  if (ty) entry.type = ty
  peerBook[idHex] = entry
  persist()
  renderContacts()
  subscribeAll()
  if (wasNew) {
    playNotify()
    flashContact(idHex)
    toast(t('added_you', { name: nick || idHex.slice(0, 8) }), 'success')
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
  // Opening a chat must NOT disturb an in-progress call window (it lives on top,
  // independently). Only reflect whether the "📞" start button should show.
  $('call-btn').hidden = callActive
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
    // Back gesture leaves the chat for the contacts list; an active call keeps
    // running in its floating window (no hangup here).
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
    // An expanded call window: back minimizes it (does NOT hang up). A
    // minimized window is left alone so back falls through to screen handling.
    const cw = $('call-window')
    if (!cw.hidden && !cw.classList.contains('mini')) { minimizeCall(); return }
    if ($('screen-call').classList.contains('active')) {
      // Leave the chat for contacts; an active call keeps running (no hangup).
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

// ── Floating call window ──────────────────────────────────────────────────────
// The call window is open for the WHOLE call lifecycle — from the first ring,
// through connecting, to connected — so you always see what's happening and can
// always hang up. It is independent of which chat is on screen.
let callActive = false                  // true between call start and a terminal state

// Terminal states end the call (window closes). Anything else means a call is
// in progress (calling / new / connecting / connected / disconnected).
const CALL_TERMINAL = new Set(['idle', 'hangup', 'rejected', 'peer hangup', 'failed', 'closed'])

function callStateLabel(s) {
  switch (s) {
    case 'calling':      return t('call_calling')
    case 'new':
    case 'connecting':   return t('call_connecting')
    case 'connected':    return t('call_connected')
    case 'disconnected': return t('call_reconnecting')
    case 'rejected':     return t('call_declined')
    case 'peer hangup':  return t('call_peer_hangup')
    case 'failed':       return t('call_failed')
    case 'hangup':
    case 'closed':
    case 'idle':         return t('call_ended')
    default:             return s
  }
}

function clearWinInline(w) {
  // Wipe inline left/top/right/bottom left over from mini-window dragging so
  // the expanded CSS layout (inset / centering) governs again.
  w.style.left = w.style.top = w.style.right = w.style.bottom = ''
}
// Reset the self-view PiP back to its default CSS anchor (drop inline coords a
// previous drag left behind).
function resetMyVideoPos() {
  const v = $('my-video')
  v.style.left = v.style.top = v.style.right = v.style.bottom = ''
}
// Persisted mic/video toggle preferences (default ON, like theme/effects).
function micPref()   { return localStorage.getItem('telefon_mic_on')   !== '0' }
function videoPref() { return localStorage.getItem('telefon_video_on') !== '0' }
function saveMicPref(on)   { localStorage.setItem('telefon_mic_on',   on ? '1' : '0') }
function saveVideoPref(on) { localStorage.setItem('telefon_video_on', on ? '1' : '0') }
// Whether the saved preference has been applied to the live call once already.
let callPrefsApplied = false

// Open the window EXPANDED — used at the very start of a call.
function openCallWindowExpanded() {
  const w = $('call-window')
  w.hidden = false
  w.classList.remove('mini')
  w.classList.add('no-remote')   // self-view fills the window until the peer connects
  clearWinInline(w)
  resetMyVideoPos()
  // Reflect the persisted mic/video preferences in the toggles; the actual call
  // tracks are aligned to these in onLocalStream once the local media arrives.
  const mt = $('mute-toggle'), vt = $('video-toggle')
  if (mt) mt.checked = micPref()
  if (vt) vt.checked = videoPref()
  callPrefsApplied = false
}
// Just ensure the window is visible WITHOUT touching the mini/expanded state —
// used by state updates so a user-chosen minimize survives later events.
function showCallWindow() { $('call-window').hidden = false }
function hideCallWindow() {
  const w = $('call-window')
  w.hidden = true
  w.classList.remove('mini')
  w.classList.remove('no-remote')
  clearWinInline(w)
  resetMyVideoPos()
}
function applyCallWindow() { callActive ? showCallWindow() : hideCallWindow() }
function minimizeCall() { if (callActive) $('call-window').classList.add('mini') }
function expandCall() {
  const w = $('call-window')
  w.classList.remove('mini')
  clearWinInline(w)
}
// Mark a call as starting and bring the window up expanded right away (before
// any state event), so the dialing phase is visible and cancellable.
function startCallUI() {
  callActive = true
  openCallWindowExpanded()
  $('call-btn').hidden = true
}

// Driven by CallManager state events for the whole call lifecycle.
function resetCallButtons(state) {
  callActive = !CALL_TERMINAL.has(state)
  applyCallWindow()
  // Hide the in-topbar "📞" call button while a call is up.
  $('call-btn').hidden = callActive
  $('cw-state').textContent = callStateLabel(state)
  // Keep the last known name if we've navigated away (currentPeerId cleared)
  // mid-call — don't blank the header on a later state change.
  const lbl = (peerBook[currentPeerId]?.label) || (currentPeerId ? currentPeerId.slice(0, 8) : '')
  if (lbl) $('cw-peer').textContent = lbl
}

/* =================================== chat =================================== */

// In-memory shadow of the on-screen chat so we can update individual
// messages (status changes) without re-querying IDB.
const renderedMessages = new Map()  // msgId -> DOM element

// Inbound chunks staging: file_id -> [chunks indexed by chunk_idx].
const inboundChunks = new Map()
// In ephemeral mode (save-chats OFF) inbound file metadata is kept here instead
// of IndexedDB: file_id -> meta { id, name, mime, size, thumb_blob }.
const inboundMetaMem = new Map()
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

async function renderFileMessage(m, fileObj = null) {
  const row = makeMsgShell(m)
  const fileId = fileIdOf(m.body)
  // In ephemeral mode the file is never written to IDB, so the caller hands us
  // the in-memory file object directly instead of going through Storage.
  const f = fileObj || await Storage.getFile(fileId)
  const box = document.createElement('div')
  box.className = 'msg-file'
  if (!f) {
    box.textContent = t('missing_file')
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
      toast(t('cannot_open_file'))
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
    toast(t('cannot_open_file'))
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
    div.textContent = `📎 ${f.name} · ${size} (${t('transferring')})`
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
    tag.textContent = t('edited')
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
  onLocalStream:  (s) => {
    $('my-video').srcObject = s || null
    // Apply persisted mic/video preferences to the live call once. _openMedia
    // starts everything ON, so we only need to switch things OFF when the saved
    // preference is OFF. Guarded by callPrefsApplied so a later device change
    // (setVideoInput also fires onLocalStream) doesn't re-toggle.
    if (s && !callPrefsApplied) {
      callPrefsApplied = true
      if (!micPref())   { call.toggleMute();  $('mute-toggle').checked  = false }
      if (!videoPref()) { call.toggleVideo(); $('video-toggle').checked = false }
    }
    if (!s) callPrefsApplied = false   // reset on teardown
  },
  onRemoteStream: (s) => {
    $('peer-video').srcObject = s || null
    // Until the remote video arrives the self-view fills the window (mirror to
    // check yourself); once it connects, shrink the self-view to the corner PiP.
    $('call-window').classList.toggle('no-remote', !s)
  },
  onState: (s) => {
    // The call window is screen-independent — drive it from state directly,
    // not from whether the matching chat is currently open.
    resetCallButtons(s)
    if (s === 'connecting' || s === 'connected') {
      // Media is open by now, so device labels are available — fill the
      // camera / microphone pickers. Safe to call repeatedly.
      populateDeviceSelectors()
    }
    if (s === 'connected') {
      stopAllRings()
      startNetDot()
    }
    if (s === 'hangup' || s === 'rejected' || s === 'peer hangup' || s === 'idle' || s === 'failed' || s === 'closed') {
      resetCallButtons('idle')
      clearIncoming()        // also stops a still-ringing prompt if the caller gave up
      stopNetDot()
      if (currentCallId) { logCall('ended', currentCallId, s); currentCallId = null }
    }
  },
  onText: async (peerId, msgId, text) => {
    const idHex = u8hex(peerId)
    if (isBanned(idHex)) return  // ignore messages from blocked peers
    const isNew = chatsPersistEnabled()
      ? await Storage.saveIncoming(idHex, msgId, text, Date.now())
      : true  // ephemeral: nothing persisted, always treat as a fresh message
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
    // Delivery confirmed → recipient has our keys; cancel the introduce-resend
    // watchdog for this message.
    const entry = pendingDelivery.get(msgId)
    if (entry) {
      if (entry.timer) clearTimeout(entry.timer)
      pendingDelivery.delete(msgId)
    }
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
    if (isBanned(u8hex(peerId))) return  // ignore file offers from blocked peers
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
    const fileMeta = { id: meta.id, mime: meta.mime, name: meta.name, size: meta.size, thumb_blob }
    if (chatsPersistEnabled()) await Storage.saveFileMeta({ ...meta, thumb_blob })
    else                       inboundMetaMem.set(meta.id, { ...fileMeta, blob: null })
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
    const persist = chatsPersistEnabled()
    const meta = persist ? await Storage.getFile(fileId) : inboundMetaMem.get(fileId)
    if (!meta) return
    const blob = new Blob(arr.filter(Boolean), { type: meta.mime })
    inboundChunks.delete(fileId)
    const idHex = u8hex(peerId)
    let isNew, fileObj
    if (persist) {
      await Storage.saveFileBlob(fileId, blob)
      isNew = await Storage.saveIncoming(idHex, msgId, `%${fileId}`, Date.now())
    } else {
      // Ephemeral: keep the assembled blob in memory only, render from it.
      meta.blob = blob
      fileObj = meta
      inboundMetaMem.delete(fileId)
      isNew = true
    }
    client.sendDeliveryAck(peerId, msgId)
    if (!isNew) return
    if (currentPeerId === idHex) {
      const row = await renderFileMessage({ id: msgId, dir: 'in', body: `%${fileId}`, status: 'received' }, fileObj)
      $('chat').appendChild(row)
      $('chat').scrollTop = $('chat').scrollHeight
      client.sendReadAck(peerId, msgId); readAcked.add(msgId)  // chat open → read right away
    } else {
      const p = peerBook[idHex]
      toast(t('sent_file', { name: p?.label || idHex.slice(0, 8), file: meta.name }))
      bumpUnread(idHex)
    }
  },
  onIncomingCall: (peerId) => {
    const idHex = u8hex(peerId)
    if (isBanned(idHex)) {        // blocked peer: silently reject, no ring/dialog
      try { call.rejectIncoming(peerId) } catch (e) { console.warn('reject banned', e) }
      return
    }
    showIncoming(peerId, idHex)
  },
})
call.attach()

let pendingIncoming = null
let incomingTimer = null
let currentCallId = null               // idHex of the call currently in progress (for the log)
const INCOMING_TIMEOUT_MS = 45000

// Show the incoming-call prompt. The ring and the dialog are started together
// here, so a ringtone can NEVER play without its window. Duplicate / replayed
// requests while one is already pending are ignored (and logged); a stale call
// nobody answers rings out after a timeout instead of forever.
function showIncoming(peerId, idHex) {
  if (pendingIncoming) { logCall('dup', idHex); return }
  pendingIncoming = { peerId, idHex }
  const name = peerBook[idHex]?.label || idHex.slice(0, 8)
  $('incoming-name').textContent = t('is_calling', { name })
  $('dialog-incoming').hidden = false
  playIncoming()
  logCall('incoming', idHex)
  clearTimeout(incomingTimer)
  incomingTimer = setTimeout(() => {
    if (pendingIncoming) { logCall('missed', pendingIncoming.idHex); clearIncoming() }
  }, INCOMING_TIMEOUT_MS)
}
// Tear the prompt down — always stops the ring AND hides the dialog together.
function clearIncoming() {
  clearTimeout(incomingTimer); incomingTimer = null
  stopAllRings()
  $('dialog-incoming').hidden = true
  pendingIncoming = null
}

$('incoming-accept').onclick = async () => {
  if (!pendingIncoming) return
  const { peerId, idHex } = pendingIncoming
  logCall('accepted', idHex)
  currentCallId = idHex
  clearIncoming()
  openCallView(idHex)
  // Bring the call window up right away (expanded) — don't wait for the first
  // connection-state event.
  startCallUI()
  $('cw-state').textContent = callStateLabel('connecting')
  // The app may have just been opened from a push while the socket was still
  // reconnecting in the background — wait for a live connection before sending
  // ACCEPT, otherwise it's fired into a dead socket and the call drops.
  const ok = await ensureConnected()
  if (!ok) { toast(t('connect_failed'), 'error'); try { call.hangup() } catch {} ; return }
  await call.acceptIncoming(peerId)
}
$('incoming-reject').onclick = () => {
  if (!pendingIncoming) return
  logCall('declined', pendingIncoming.idHex)
  call.rejectIncoming(pendingIncoming.peerId)
  clearIncoming()
}

/* =================================== client wiring =================================== */

// Map raw WS state to an i18n key for the short user-facing status + LED class.
// The label is resolved through lui.t at render time so it follows the language.
const STATE_LABELS = {
  connecting:    ['state_offline',      'dot-off'],
  handshaking:   ['state_connecting',   'dot-warn'],
  established:   ['state_online',       'dot-on'],
  closed:        ['state_offline',      'dot-off'],
  'reconnect-in':['state_reconnecting', 'dot-warn'],
  rejected:      ['state_session_taken','dot-off'],
  backoff:       ['state_offline',      'dot-off'],
  idle:          ['state_offline',      'dot-off'],
  disconnected:  ['state_offline',      'dot-off'],
}
let lastConnState = 'connecting'  // remembered so a live lang switch can re-render it

client.onState = ({ state, detail }) => {
  lastConnState = state
  const [key, dotClass] = STATE_LABELS[state] || [null, 'dot-off']
  $('conn-text').textContent = key ? t(key) : state
  $('conn-led').className = 'dot ' + dotClass
  const banner = $('fatal-banner')
  if (state === 'rejected') {
    banner.hidden = false
    banner.textContent = t('session_in_use')
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

// Re-render the connection-status pill in the current language (used on a live
// 'lui:lang' switch — onState only fires on actual state changes).
function refreshConnText() {
  const [key] = STATE_LABELS[lastConnState] || [null]
  $('conn-text').textContent = key ? t(key) : lastConnState
  if (lastConnState === 'rejected') {
    const banner = $('fatal-banner')
    if (banner && !banner.hidden) banner.textContent = t('session_in_use')
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
  } else if (msg.cmd === CMD.INFO) {
    showServerInfo(msg.body)
  }
}

// Server-originated plain-text notice (CMD.INFO 0x88): show it to the user in a
// simple modal. The text is UNTRUSTED (a compromised server could send anything),
// so it's rendered with textContent only (never innerHTML — no HTML/script can
// run) and length-capped; the worst a hostile server can do is pop up some text.
function showServerInfo(bodyU8) {
  let text = ''
  try { text = new TextDecoder().decode(bodyU8).slice(0, 2000) } catch { return }
  if (!text.trim()) return
  const overlay = document.createElement('div')
  overlay.className = 'dialog'
  const box = document.createElement('div'); box.className = 'dialog-box'
  const ttl = document.createElement('div'); ttl.className = 'dialog-title'; ttl.textContent = t('server_message')
  const body = document.createElement('div'); body.className = 'dialog-text'
  body.textContent = text                       // textContent = no HTML injection
  body.style.cssText = 'white-space:pre-wrap; max-height:50vh; overflow-y:auto'
  const btns = document.createElement('div'); btns.className = 'dialog-buttons'
  const ok = document.createElement('button'); ok.className = 'primary'; ok.textContent = t('ok')
  ok.onclick = () => overlay.remove()
  btns.appendChild(ok)
  box.append(ttl, body, btns)
  overlay.appendChild(box)
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove() }
  document.body.appendChild(overlay)
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

// Keep the socket fresh on foreground. After the app is backgrounded the OS may
// close the WebSocket; on resume we force an IMMEDIATE reconnect instead of
// waiting out the exponential backoff — this is what makes answering a call
// right after a push reliable.
// Returning to the app, or regaining network, must guarantee a LIVE socket.
// The server already pings every 20s (keeps a healthy socket alive and drops
// dead ones), but a backgrounded mobile WebView often holds a dead-but-OPEN
// socket the server has already dropped: readyState lies and the `close` event
// never fires over the dead path, so the app thinks it's online and nothing
// arrives until a manual restart. So don't trust isConnected() alone — if the
// socket is closed OR has been silent suspiciously long, force a fresh one.
// (No client-side keepalive packets: liveness is the server's job; we only
// reconnect on real foreground/network events.)
function wakeConnection() {
  try {
    // Server pings every 20s; a healthy gap is <=~22s. On wake, reconnect only
    // if the last inbound is older than one ping cycle + jitter — don't tear
    // down a live channel — and well under the server's 60s drop timeout.
    const stale = Date.now() - (client.lastRx || 0) > 25000
    if (!client.isConnected() || stale) client.forceReconnect()
  } catch {}
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) wakeConnection() })
window.addEventListener('online', wakeConnection)
window.addEventListener('focus', wakeConnection)
;(() => {
  const CapApp = window.Capacitor?.Plugins?.App
  if (CapApp?.addListener) CapApp.addListener('appStateChange', ({ isActive }) => { if (isActive) wakeConnection() })
})()

// Passive staleness watchdog. The server emits a VISIBLE plain-text "ping"
// keepalive every ~20s (outside the encrypted protocol); ws_client answers
// "pong" and bumps client.lastRx — we only OBSERVE arrival here and send
// NOTHING extra ourselves. If the app is foregrounded, the socket claims to be
// connected, yet no frame (not even a ping) has arrived for ~2.5× the server
// interval, the socket has silently gone deaf: force a fresh one. Disarmed
// until we've actually seen a "ping" (client.appPingSeen), so against a server
// that doesn't emit them we never churn.
const STALE_MS = 50000   // ≈ 2.5 × the 20s server ping interval
setInterval(() => {
  try {
    if (!client.appPingSeen) return                // backward-compatible: don't churn
    if (document.hidden) return                    // OS may suspend us; foreground only
    if (!client.isConnected()) return              // close/reconnect already handles this
    if (Date.now() - (client.lastRx || 0) > STALE_MS) client.forceReconnect()
  } catch {}
}, 10000)

// Wait until the socket is established (kicking an immediate reconnect first),
// up to timeoutMs. Used before sending a call ACCEPT so it isn't lost.
function ensureConnected(timeoutMs = 8000) {
  if (client.isConnected && client.isConnected()) return Promise.resolve(true)
  try { client.reconnectNow && client.reconnectNow() } catch {}
  return new Promise((resolve) => {
    const t0 = Date.now()
    const iv = setInterval(() => {
      if (client.isConnected && client.isConnected()) { clearInterval(iv); resolve(true) }
      else if (Date.now() - t0 > timeoutMs) { clearInterval(iv); resolve(false) }
    }, 150)
  })
}

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
  try { inviteNick = splitNickType(client.session.constructor.nicknameFromQr(incomingInvite)).name } catch {}
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
    const nick = splitNickType(client.session.constructor.nicknameFromQr(qr)).name // static
    if (nick && !$('add-label').value) $('add-label').value = nick
  } catch {}
})
$('add-cancel').onclick = () => { $('dialog-add').hidden = true }
$('add-save').onclick = () => {
  const qr = extractQrText($('add-qr').value)
  if (!qr) {
    showAddError(t('not_peer_code'))
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
    toast(t('contact_added', { name: label || idHex.slice(0, 8) }), 'success')
  } catch (e) {
    showAddError(t('code_rejected', { err: e }))
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
        const body  = notif?.body  || notif?.data?.body  || t('new_message')
        try {
          const LN = window.Capacitor?.Plugins?.LocalNotifications
          if (LN) {
            // Ephemeral mode (save-chats OFF): there is no persisted history to
            // scroll back to, so keep the notification sticky (ongoing, not
            // auto-cancelled) until the user dismisses it. Normal mode behaves
            // as before (tap-to-dismiss).
            const ephemeral = !chatsPersistEnabled()
            LN.schedule({ notifications: [{
              id: Date.now() % 1000000,
              title, body,
              channelId: 'telefon_messages',
              ongoing: ephemeral,
              autoCancel: !ephemeral,
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
  toast(t('app_installed'), 'success')
})
const NATIVE_APP = !!(window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function'
  && window.Capacitor.isNativePlatform())
// The install button is a web-only icon: hidden in the native app (updating
// lives in Settings → Check for updates) and in an already-installed PWA;
// shown in a plain browser as an "Install" affordance.
if (NATIVE_APP || matchMedia('(display-mode: standalone)').matches) {
  $('btn-install').hidden = true
} else {
  $('btn-install').hidden = false
}
// In a mobile browser (not the native app), offer the APK download.
if (!NATIVE_APP && /Android/.test(navigator.userAgent)) {
  $('btn-apk').hidden = false
}
$('btn-apk').onclick = () => {
  window.open('https://tele.karlson.ru/apk/telefon-latest.apk', '_blank')
}

// The installed version string used for update comparison. In the native APK the
// #build-tag is the literal placeholder "build __BUILD__" (the build script only
// rewrites digit patterns), so reading it would always look out-of-date. Prefer
// Capacitor App.getInfo().version (= Android versionName, set correctly per
// build); fall back to #build-tag on the web / when the plugin is absent.
async function installedVersion() {
  try {
    const App = window.Capacitor?.Plugins?.App
    if (App?.getInfo) {
      const i = await App.getInfo()
      if (i && i.version) return String(i.version).trim()
    }
  } catch {}
  return ($('build-tag')?.textContent || '').replace(/^build\s*/, '').trim()
}

async function checkAndUpdate() {
  const cur = await installedVersion()
  let latest = ''
  try {
    const r = await fetch('https://tele.karlson.ru/apk/version.txt?t=' + Date.now())
    latest = (await r.text()).trim()
  } catch { toast(t('update_check_failed'), 'error'); return }
  if (!latest) { toast(t('version_not_found'), 'error'); return }
  if (latest === cur) { toast(t('up_to_date', { ver: cur }), 'success'); return }
  if (confirm(t('new_version_q', { latest, cur }))) {
    // _system → Capacitor opens it in the external browser / DownloadManager.
    window.open('https://tele.karlson.ru/apk/telefon-latest.apk?t=' + Date.now(), '_system')
  }
}

function manualInstallHint() {
  const ua = navigator.userAgent
  if (/iPhone|iPad|iPod/.test(ua)) return t('hint_ios')
  if (/Android/.test(ua))          return t('hint_android')
  return t('hint_generic')
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
      await navigator.share({ title: t('share_title'), text: t('share_text'), url })
    } else {
      await navigator.clipboard.writeText(url)
      toast(t('invite_copied'), 'success')
    }
  } catch (e) {
    toast(t('share_failed', { err: e }), 'error')
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
    toast(t('copied'))
  } catch (e) { console.warn('copy failed:', e); toast(t('copy_failed')) }
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
  if (isOut && !isFile) item(t('edit'), () => enterEditMode(msgId))
  if (!isFile) item(t('copy'), () => copyMsgText(row))
  item(t('del_msg'), () => openDeleteDialog(msgId, isOut), 'danger')

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
  b.textContent = t('copy')
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
        toast(t('copied'))
      } catch (e) { console.warn('copy failed', e); toast(t('copy_failed')) }
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
  title.className = 'dialog-title'; title.textContent = t('del_msg_title')
  box.appendChild(title)

  const btns = document.createElement('div')
  btns.className = 'dialog-buttons'; btns.style.flexWrap = 'wrap'
  const mkBtn = (label, cls, fn) => {
    const b = document.createElement('button'); b.className = cls; b.textContent = label; b.onclick = fn
    btns.appendChild(b)
  }
  mkBtn(t('cancel'), 'secondary', close)
  mkBtn(t('del_for_me'), 'danger', () => doDelete(false))
  if (isOut) mkBtn(t('del_for_all'), 'danger', () => doDelete(true))
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
      <div class="dialog-title">${escapeHtml(t('clear_history_title'))}</div>
      <div class="dialog-text">${escapeHtml(t('clear_history_text', { name }))}</div>
    </div>`
  const btns = document.createElement('div')
  btns.className = 'dialog-buttons'
  const cancel = document.createElement('button'); cancel.className = 'secondary'; cancel.textContent = t('cancel'); cancel.onclick = close
  const ok = document.createElement('button'); ok.className = 'danger'; ok.textContent = t('clear')
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
    ? t('found', { n: rows.length })
    : t('nothing_found')
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
  // Leaving the chat no longer ends the call — it keeps running in its own
  // floating window. Just return to the contacts list.
  currentPeerId = null
  showScreen('contacts')
  // Pop our synthetic history entry so back/forward stays consistent.
  if (history.state?.screen === 'call') history.back()
}
// Start an outgoing call to a peer. Used by the in-chat 📞 button and by tapping
// a contact's avatar in the list (call straight away, no chat first).
function startOutgoingCall(idHex) {
  if (!idHex || callActive) return   // ignore if a call is already up
  currentPeerId = idHex
  const peerId = hexU8(idHex)
  // Open the call window immediately (expanded) so the dialing phase is visible
  // and cancellable before any state event arrives.
  startCallUI()
  $('cw-state').textContent = callStateLabel('calling')
  const p = peerBook[idHex]
  $('cw-peer').textContent = p?.label || idHex.slice(0, 8)
  // Re-introduce ourselves first so the callee can decrypt our CALL_REQUEST
  // even if they don't yet have our keys (e.g. they were offline when the
  // initial INTRODUCE was sent right after we added their QR).
  client.introduce(peerId, nickname || '')
  call.call(peerId)
  currentCallId = idHex
  logCall('outgoing', idHex)
  playOutgoing()
  // Push-wake an offline callee so a backgrounded app can ring.
  maybeWake(idHex, true)  // true = call → ringtone push
}
$('call-btn').onclick = () => startOutgoingCall(currentPeerId)
$('hangup-btn').onclick = () => call.hangup()

/* Floating call-window chrome. Minimize collapses to a draggable PiP; close
 * hangs up (onState→idle then hides the window via resetCallButtons). */
$('cw-min').onclick   = minimizeCall
$('cw-close').onclick = () => call.hangup()
// Direct hang-up from the minimized PiP. stopPropagation so the window's
// pointer handlers don't also treat it as a tap-to-expand.
$('cw-mini-end').onclick = (e) => { e.stopPropagation(); call.hangup() }

$('switch-cam').onclick = () => call.switchCamera()
// Mic toggle: checked = mic ON. toggleMute() returns the new muted state, so
// the checkbox is the negation of it (kept in sync even if the call flips it).
$('mute-toggle').onchange = (e) => {
  const muted = call.toggleMute()
  const on = !muted
  e.target.checked = on
  saveMicPref(on)
}
// Video toggle: checked = video ON. toggleVideo() returns the new "off" state.
$('video-toggle').onchange = (e) => {
  const off = call.toggleVideo()
  const on = !off
  e.target.checked = on
  saveVideoPref(on)
}

/* Device selection moved into a single "Call settings" window (⚙). Camera,
 * microphone and speaker pickers appear only when more than one device of that
 * kind exists; video quality is always offered. Switching a track replaces it
 * in the live RTCPeerConnection without renegotiating. */
let curCamId = null, curMicId = null, curSpkId = null
let curRes = 480   // current video quality (vertical px); default 480p

// Called on connecting/connected. The settings icon (⚙) is always visible
// (quality is always selectable), so this no longer toggles icon visibility —
// it's kept as a hook in case device labels need pre-warming.
async function populateDeviceSelectors() {
  try { await call.listDevices() } catch {}
}

$('dev-pick').onclick = () => openDeviceSettings()

// Single settings window: builds a section per available choice. Only renders a
// device section when there's a real choice (>1 device); quality is always
// shown. Uses .dialog so it sits above the call window (z-index 1000).
async function openDeviceSettings() {
  let devs = {}
  try { devs = await call.listDevices() } catch {}
  let outs = []
  try { outs = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audiooutput') } catch {}

  const overlay = document.createElement('div'); overlay.className = 'dialog'
  const box = document.createElement('div'); box.className = 'dialog-box'
  const ttl = document.createElement('div'); ttl.className = 'dialog-title'; ttl.textContent = t('call_settings')
  box.appendChild(ttl)

  // Add a labelled section of tappable items; `items` is [{label, id, on?}].
  // `currentId` ticks the active one; tapping calls apply(id) then closes.
  const addSection = (heading, items, currentId, apply) => {
    const h = document.createElement('div'); h.className = 'dlg-section'; h.textContent = heading
    const list = document.createElement('div'); list.className = 'dev-list'
    items.forEach((it, i) => {
      const b = document.createElement('button'); b.className = 'msg-menu-item'
      const on = it.id === currentId
      b.textContent = (on ? '✓ ' : '') + (it.label || `${heading} ${i + 1}`)
      b.onclick = () => { overlay.remove(); apply(it.id) }
      list.appendChild(b)
    })
    box.append(h, list)
  }

  const cams = devs.videoInputs || []
  if (cams.length > 1) {
    addSection(t('dev_camera'),
      cams.map((d, i) => ({ label: d.label || `${t('dev_camera')} ${i + 1}`, id: d.deviceId })),
      curCamId, (id) => { curCamId = id; call.setVideoInput(id) })
  }
  const mics = devs.audioInputs || []
  if (mics.length > 1) {
    addSection(t('dev_mic'),
      mics.map((d, i) => ({ label: d.label || `${t('dev_mic')} ${i + 1}`, id: d.deviceId })),
      curMicId, (id) => { curMicId = id; call.setAudioInput(id) })
  }
  if (outs.length > 1) {
    addSection(t('dev_speaker'),
      outs.map((d, i) => ({ label: d.label || `${t('dev_speaker')} ${i + 1}`, id: d.deviceId })),
      curSpkId, async (id) => {
        try { await call.setAudioSink(id); curSpkId = id }
        catch (e) { toast(t('audio_sink_err', { err: e.message }), 'error') }
      })
  }
  // Quality is always available.
  addSection(t('resolution'),
    [240, 360, 480, 720].map(p => ({ label: `${p}p`, id: p })),
    curRes, (p) => { curRes = p; call.setVideoResolution(p) })

  const btns = document.createElement('div'); btns.className = 'dialog-buttons'
  const cancel = document.createElement('button'); cancel.className = 'secondary'; cancel.textContent = t('cancel')
  cancel.onclick = () => overlay.remove()
  btns.appendChild(cancel)
  box.appendChild(btns)
  overlay.appendChild(box)
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove() }
  document.body.appendChild(overlay)
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

  // Persist first so the message survives a refresh / offline retry. In
  // ephemeral mode (save-chats OFF) nothing is written — we only mint an id and
  // render the bubble in-memory.
  const persist = chatsPersistEnabled()
  const msgId = persist ? await Storage.saveOutgoing(currentPeerId, text) : crypto.randomUUID()
  appendChatRow({ id: msgId, dir: 'out', body: text, status: 'pending' })
  $('chat').scrollTop = $('chat').scrollHeight
  $('text-input').value = ''
  autoGrowInput()
  // Send the TEXT alone — no INTRODUCE per message (wasteful at scale). If WS is
  // down the outbox entry stays and we retry on PEER_ONLINE. If the recipient
  // lacks our keys, the delivery watchdog notices the missing ack and resends
  // with an INTRODUCE.
  const ok = client.sendText(peerId, msgId, text)
  if (ok && persist) {
    await Storage.markStatus(msgId, 'sent')
    updateRowStatus(msgId, 'sent')
  } else if (ok) {
    updateRowStatus(msgId, 'sent')
  }
  if (ok) {
    // Arm the delivery watchdog: if no DELIVERY_ACK arrives while we're online,
    // the recipient probably lacks our keys → introduce + resend (once).
    const entry = { peerId, nick: nickname || '', text, retried: false, timer: null }
    entry.timer = setTimeout(() => deliveryWatchdog(msgId), DELIVERY_WATCHDOG_MS)
    pendingDelivery.set(msgId, entry)
  }
  // If the recipient is offline, nudge the server to push-wake them.
  maybeWake(currentPeerId)
}

// Delivery watchdog: runs DELIVERY_WATCHDOG_MS after a text send (and again after
// a retried send). Drives the "introduce only on delivery failure" recovery.
function deliveryWatchdog(msgId) {
  try {
    const entry = pendingDelivery.get(msgId)
    if (!entry) return  // already delivery-acked and cleared
    if (!client.isConnected()) {
      // Offline: the outbox / flushOutboxFor(PEER_ONLINE) path will redeliver.
      // Stop watching (don't loop) but leave the entry harmlessly idle.
      entry.timer = null
      return
    }
    if (!entry.retried) {
      // Online but no ack → recipient likely lacks our keys. Introduce + resend.
      client.introduce(entry.peerId, entry.nick || '')
      client.sendText(entry.peerId, msgId, entry.text)
      entry.retried = true
      entry.timer = setTimeout(() => deliveryWatchdog(msgId), DELIVERY_WATCHDOG_MS)
    } else {
      // Second timeout, still no ack: give up here. The outbox /
      // flushOutboxFor on the next PEER_ONLINE will redeliver later.
      pendingDelivery.delete(msgId)
    }
  } catch (e) {
    console.warn('deliveryWatchdog', e)
  }
}

/* =================================== file send =================================== */

$('attach-btn').onclick = () => $('file-input').click()
$('file-input').onchange = async (e) => {
  const files = Array.from(e.target.files || [])
  e.target.value = ''
  for (const file of files) await sendFile(file)
}

async function sendFile(file) {
  if (!currentPeerId) { toast(t('no_peer'), 'error'); return }
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
  const thumb_blob = thumb_b64 ? blobFromB64(thumb_b64, 'image/jpeg') : null
  // In ephemeral mode (save-chats OFF) nothing is written to IDB; we render the
  // bubble straight from the in-memory file object instead.
  const persist = chatsPersistEnabled()
  let fileObj = null
  if (persist) {
    await Storage.saveFileMeta({ ...meta, thumb_blob })
    await Storage.saveFileBlob(fileId, file)  // we already have the blob locally
    await DB.add('telefon.lleo.me', 'messages', {
      id: msgId, peer_id: currentPeerId, dir: 'out',
      body: `%${fileId}`, ts: Date.now(), status: 'pending',
    })
    await DB.add('telefon.lleo.me', 'outbox', { id: msgId, attempts: 0, last_try_ts: 0 })
  } else {
    fileObj = { id: fileId, name: meta.name, mime: meta.mime, size: meta.size, blob: file, thumb_blob }
  }

  // Render the bubble locally first.
  const row = await renderFileMessage({ id: msgId, dir: 'out', body: `%${fileId}`, status: 'pending' }, fileObj)
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
  if (persist) await Storage.markStatus(msgId, 'sent')
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

/* =============================== connection-type dot =============================== */
// Small dot in the call header: green = direct P2P, orange = relayed via TURN
// (our coturn). Polls getStats while connected; candidateType 'relay' on either
// end means the media goes through TURN.
let netDotTimer = null
async function refreshNetDot() {
  const el = $('cw-net')
  let s = null
  try { s = await call.getStats() } catch {}
  if (!s) return
  const relayed = s.local === 'relay' || s.remote === 'relay'
  el.textContent = relayed ? 'stun' : 'direct'   // technical terms, kept literal
  el.classList.toggle('relay', relayed)
  el.classList.toggle('direct', !relayed)
  el.title = relayed ? t('net_relay') : t('net_direct')
  el.hidden = false
}
function startNetDot() {
  stopNetDot()
  refreshNetDot()
  netDotTimer = setInterval(refreshNetDot, 3000)
}
function stopNetDot() {
  if (netDotTimer) { clearInterval(netDotTimer); netDotTimer = null }
  const el = $('cw-net'); if (el) { el.hidden = true; el.textContent = ''; el.classList.remove('relay', 'direct') }
}

/* =================================== stats overlay =================================== */

let statsTimer = null
async function refreshStats() {
  const ov = $('stats-overlay')
  const s = await call.getStats()
  if (!s) { ov.textContent = t('no_session'); return }
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
    // While the self-view fills the window (no remote yet) it isn't a draggable
    // PiP — skip so it doesn't get pinned to inline coords.
    if ($('call-window').classList.contains('no-remote')) return
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

/* Drag the minimized call window around the viewport; a tap (no real movement)
 * re-expands it. Only active while the window carries the `.mini` class — the
 * expanded window is never draggable. Mirrors initDraggablePip's tap/drag
 * threshold logic, but moves #call-window within the viewport (not the stage). */
function initCallWindowDrag() {
  const win = $('call-window')
  if (!win) return

  const DRAG_THRESHOLD = 5  // px; below this it's a tap, not a drag
  let dragging = false
  let moved = false
  let startX = 0, startY = 0          // pointer position at pointerdown
  let baseLeft = 0, baseTop = 0       // window top-left at pointerdown (viewport)
  let activePointer = null

  const clamp = (v, min, max) => Math.max(min, Math.min(max, v))

  // Convert the current right/bottom anchoring to left/top so we can move it
  // freely. Coordinates are viewport-relative.
  function switchToLeftTop() {
    const r = win.getBoundingClientRect()
    win.style.left   = r.left + 'px'
    win.style.top    = r.top  + 'px'
    win.style.right  = 'auto'
    win.style.bottom = 'auto'
    return { left: r.left, top: r.top }
  }

  win.addEventListener('pointerdown', (e) => {
    if (!win.classList.contains('mini')) return  // expanded window: not draggable
    if (e.target.closest('#cw-mini-end')) return // the PiP hang-up button handles itself
    const pos = switchToLeftTop()
    baseLeft = pos.left
    baseTop  = pos.top
    startX = e.clientX
    startY = e.clientY
    dragging = true
    moved = false
    activePointer = e.pointerId
    win.setPointerCapture(e.pointerId)
  })

  win.addEventListener('pointermove', (e) => {
    if (!dragging || e.pointerId !== activePointer) return
    const dx = e.clientX - startX
    const dy = e.clientY - startY
    if (!moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return  // still a tap
    moved = true
    win.classList.add('dragging')
    const maxLeft = window.innerWidth  - win.offsetWidth
    const maxTop  = window.innerHeight - win.offsetHeight
    win.style.left = clamp(baseLeft + dx, 0, Math.max(0, maxLeft)) + 'px'
    win.style.top  = clamp(baseTop  + dy, 0, Math.max(0, maxTop))  + 'px'
    e.preventDefault()
  })

  const endDrag = (e) => {
    if (!dragging || (activePointer !== null && e.pointerId !== activePointer)) return
    dragging = false
    activePointer = null
    win.classList.remove('dragging')
    try { win.releasePointerCapture(e.pointerId) } catch {}
    // No real movement while minimized → treat as a tap: re-expand.
    if (!moved && win.classList.contains('mini')) expandCall()
  }
  win.addEventListener('pointerup', endDrag)
  win.addEventListener('pointercancel', endDrag)
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

// base64 <-> Uint8Array for the 32-byte identity seeds.
function u8ToB64(u8) { let s = ''; for (const b of u8) s += String.fromCharCode(b); return btoa(s) }
function b64ToU8(s) { const d = atob(s); const u = new Uint8Array(d.length); for (let i = 0; i < d.length; i++) u[i] = d.charCodeAt(i); return u }

// ── Encrypted backup (WebCrypto: PBKDF2 → AES-GCM-256) ─────────────────────────
// Derive an AES-GCM key from a password + salt via PBKDF2-SHA256.
async function deriveBackupKey(password, salt, iter = 200000) {
  const enc = new TextEncoder()
  const baseKey = await crypto.subtle.importKey(
    'raw', enc.encode(password), 'PBKDF2', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false, ['encrypt', 'decrypt'])
}

// Encrypt an inner backup object with a password. Returns the on-disk envelope
// (salt/iv/ct base64) so the file is fully self-describing for decryption.
async function encryptBackup(inner, password) {
  const iter = 200000
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iv   = crypto.getRandomValues(new Uint8Array(12))
  const key  = await deriveBackupKey(password, salt, iter)
  const pt   = new TextEncoder().encode(JSON.stringify(inner))
  const ctBuf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, pt)
  return {
    v: 1, type: 'telefon-account', enc: 'aes-gcm', kdf: 'pbkdf2', hash: 'SHA-256',
    iter,
    salt: u8ToB64(salt), iv: u8ToB64(iv), ct: u8ToB64(new Uint8Array(ctBuf)),
  }
}

// Decrypt an encrypted envelope with a password; returns the inner object.
// Throws if the password is wrong or the ciphertext is corrupt (AES-GCM auth).
async function decryptBackup(env, password) {
  const salt = b64ToU8(env.salt)
  const iv   = b64ToU8(env.iv)
  const ct   = b64ToU8(env.ct)
  const key  = await deriveBackupKey(password, salt, env.iter || 200000)
  const ptBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct)
  return JSON.parse(new TextDecoder().decode(new Uint8Array(ptBuf)))
}

// ── Ephemeral mode: persist-chats toggle ───────────────────────────────────────
// Default ON. localStorage 'telefon_persist_chats': absent/'1' = ON, '0' = OFF.
// When OFF (ephemeral), incoming/outgoing messages and files are NOT written to
// IndexedDB — they only render in-memory in the open chat and vanish on restart.
function chatsPersistEnabled() {
  return localStorage.getItem('telefon_persist_chats') !== '0'
}

// ── Block list ─────────────────────────────────────────────────────────────────
// Blacklist of banned peers. localStorage 'telefon_banned' = JSON array of
// objects { id, qr, label } so a banned contact can be fully restored later.
// A banned peer is removed from the contact list entirely: their incoming
// text/calls/files are ignored, their chat is wiped, and a fresh INTRO_FROM
// from them does NOT re-create the contact (see handleIntroFrom).
function loadBlacklist() {
  try {
    const raw = JSON.parse(localStorage.getItem('telefon_banned') || '[]')
    // Migrate the legacy format (a bare array of idHex strings) to objects.
    return raw.map(e => (typeof e === 'string' ? { id: e, qr: null, label: null } : e))
              .filter(e => e && e.id)
  } catch { return [] }
}
function saveBlacklist(arr) {
  try { localStorage.setItem('telefon_banned', JSON.stringify(arr)) } catch {}
}
let blacklist = loadBlacklist()
function isBanned(idHex) { return blacklist.some(e => e.id === idHex) }

// Ban a contact: confirm, then wipe its chat, drop it from the list and the
// WASM session, and record { id, qr, label } in the blacklist for later restore.
function banContact(idHex) {
  const p = peerBook[idHex]
  const name = p?.label || idHex.slice(0, 8)
  window.lui.confirm({
    icon: '🚫', title: t('ban'), text: t('ban_warn'),
    danger: true, ok: t('ban'), cancel: t('cancel'),
  }, async () => {
    // Remember enough to restore the contact if it's later unblocked.
    if (!isBanned(idHex)) {
      blacklist.push({ id: idHex, qr: p?.qr || null, label: p?.label || null })
      saveBlacklist(blacklist)
    }
    // Wipe the conversation immediately and remove the contact entirely.
    try { await Storage.clearHistory(idHex) } catch (e) { console.warn('clearHistory', e) }
    clearUnread(idHex)
    delete peerBook[idHex]
    persist()
    try { client.removePeer(hexU8(idHex)) } catch (e) { console.warn('removePeer', e) }
    // If we're looking at this contact's chat, drop back to the list.
    if (currentPeerId === idHex) {
      try { call.hangup() } catch {}
      currentPeerId = null
      showScreen('contacts')
      if (history.state?.screen === 'call') history.back()
    }
    renderContacts()
    toast(t('deleted', { name }), 'success')
  })
}

// Unblock a peer: remove it from the blacklist and restore it as a contact
// from the saved { qr, label } so it reappears in the main list.
function unbanContact(idHex) {
  const entry = blacklist.find(e => e.id === idHex)
  blacklist = blacklist.filter(e => e.id !== idHex)
  saveBlacklist(blacklist)
  if (entry && entry.qr) {
    peerBook[idHex] = { qr: entry.qr, label: entry.label || null, online: false }
    try { client.addPeerFromQr(entry.qr) } catch (e) { console.warn('restore peer', e) }
    persist()
    subscribeAll()
  }
  renderContacts()
}

// Blacklist window: list every banned contact with an Unblock button. Opened
// from Settings. Unblocking restores the contact to the main list and removes
// it here; the window re-renders in place (or shows the empty state).
// Viewer for the call log (Settings → Call log). Newest first; clearable.
function openCallLogWindow() {
  const lui = window.lui
  const ICON = { incoming: '◀', outgoing: '▶', accepted: '✅', declined: '⛔', missed: '❌', dup: '♻️', ended: '⏹' }
  const fmt = (ts) => {
    const d = new Date(ts), p = (n) => String(n).padStart(2, '0')
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  }
  const rowsHtml = () => {
    const log = loadCallLog().slice().reverse()
    if (!log.length) return `<div class="muted" style="padding:1rem;text-align:center">${escapeHtml(t('call_log_empty'))}</div>`
    return log.map(e =>
      `<div style="display:flex;gap:.5rem;align-items:center;padding:.35rem .2rem;border-bottom:1px solid var(--line);font-size:.85rem">`
      + `<span style="width:1.4em;text-align:center">${ICON[e.ev] || '·'}</span>`
      + `<span style="flex:0 0 5.5em;color:var(--ink-soft)">${escapeHtml(e.ev)}</span>`
      + `<span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(e.name || '—')}</span>`
      + `<span style="color:var(--ink-soft);font-family:ui-monospace,monospace;font-size:.78rem">${fmt(e.t)}</span></div>`
    ).join('')
  }
  const html = `<div class="call-log">${rowsHtml()}</div>`
    + `<div style="text-align:right;margin-top:.6rem"><button id="cl-clear" class="btn btn-ghost">${escapeHtml(t('call_log_clear'))}</button></div>`
  const w = lui.win(t('call_log'), html)
  w.querySelector('#cl-clear').onclick = () => {
    try { localStorage.removeItem(CALL_LOG_KEY) } catch {}
    w.querySelector('.call-log').innerHTML = rowsHtml()
  }
}

function openBlacklistWindow() {
  const w = window.lui.win(t('blacklist_title'), '<div class="set-blacklist"></div>')
  const box = w.querySelector('.set-blacklist')
  const render = () => {
    box.innerHTML = ''
    if (blacklist.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'muted'
      empty.style.padding = '12px 0'
      empty.textContent = t('blacklist_empty')
      box.appendChild(empty)
      return
    }
    for (const e of blacklist) {
      const row = document.createElement('div')
      row.className = 'set-line'
      const label = document.createElement('span')
      label.className = 'set-label'
      label.textContent = e.label || e.id.slice(0, 8)
      const btn = document.createElement('button')
      btn.className = 'btn btn-ghost'
      btn.textContent = t('unblock')
      btn.onclick = () => { unbanContact(e.id); render() }
      row.appendChild(label)
      row.appendChild(btn)
      box.appendChild(row)
    }
  }
  render()
}

// Centered modal asking for a single password (shown as VISIBLE text — never a
// masked field, per Leo's rule). Resolves with the entered string ('' allowed)
// or null on cancel. `subtitle` explains what the password is for.
function askPassword(title, subtitle) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div')
    overlay.className = 'dialog'
    let settled = false
    const finish = (val) => { if (settled) return; settled = true; overlay.remove(); resolve(val) }
    const box = document.createElement('div')
    box.className = 'dialog-box'
    const ttl = document.createElement('div')
    ttl.className = 'dialog-title'; ttl.textContent = title
    box.appendChild(ttl)
    if (subtitle) {
      const sub = document.createElement('div')
      sub.className = 'dialog-text'; sub.textContent = subtitle
      box.appendChild(sub)
    }
    const inp = document.createElement('input')
    // Visible plain text — NOT type=password (no masking), per project rule.
    // Bare type=text matches the other dialogs' inputs (global input[type=text]).
    inp.type = 'text'
    inp.autocapitalize = 'off'
    inp.autocomplete = 'off'
    inp.spellcheck = false
    box.appendChild(inp)
    const btns = document.createElement('div')
    btns.className = 'dialog-buttons'
    const cancel = document.createElement('button')
    cancel.className = 'secondary'; cancel.textContent = t('cancel')
    cancel.onclick = () => finish(null)
    const ok = document.createElement('button')
    ok.className = 'primary'; ok.textContent = t('ok')
    ok.onclick = () => finish(inp.value)
    btns.appendChild(cancel); btns.appendChild(ok)
    box.appendChild(btns)
    overlay.appendChild(box)
    overlay.onclick = (e) => { if (e.target === overlay) finish(null) }
    inp.onkeydown = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); finish(inp.value) }
      else if (e.key === 'Escape') { e.preventDefault(); finish(null) }
    }
    document.body.appendChild(overlay)
    inp.focus()
  })
}

// Generic file save: native share-sheet in the APK (Android WebView can't
// download blob: URLs), plain <a download> on the web.
async function saveTextFile(name, text, mime = 'application/json') {
  const blob = new Blob([text], { type: mime })
  if (NATIVE_APP) { await openFileNative({ name, blob }); return }
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob); a.download = name; a.click()
  URL.revokeObjectURL(a.href)
}

// The secret core of a backup: identity seeds + nickname + contacts.
// Deliberately NOT chat history or files — those are not exported. This object
// is what gets encrypted when a password is supplied.
function buildAccountInner() {
  const s = loadSeeds()
  const contacts = Object.entries(loadPeers())
    .filter(([, p]) => p?.qr)
    .map(([id, p]) => ({ id, qr: p.qr, label: p.label || null, ...(p.type ? { type: p.type } : {}) }))
  return {
    nickname: loadNickname() || null,
    seeds: s ? { x: u8ToB64(s.xSeed), ed: u8ToB64(s.edSeed) } : null,
    contacts,
  }
}

// Unencrypted on-disk envelope (enc:false) wrapping the inner secret object.
function buildAccountBackup() {
  return { v: 1, type: 'telefon-account', enc: false, ...buildAccountInner() }
}

// Apply a decrypted/plain inner backup: overwrite identity + contacts, reload.
function applyAccountInner(inner) {
  if (inner.seeds?.x && inner.seeds?.ed) saveSeeds(b64ToU8(inner.seeds.x), b64ToU8(inner.seeds.ed))
  if (inner.nickname) saveNickname(inner.nickname)
  const peers = {}
  for (const c of (inner.contacts || [])) {
    if (c?.id && c?.qr?.startsWith('K0')) {
      const e = { qr: c.qr, label: c.label || null }
      if (c.type) e.type = c.type
      peers[c.id] = e
    }
  }
  savePeers(peers)
  toast(t('acc_imported'), 'success')
  setTimeout(() => location.reload(), 700)
}

// Export the account. Asks for an optional password: empty → unencrypted
// (human-readable, editable) JSON; non-empty → AES-GCM-encrypted envelope.
// Either way the file is named telefon-account.json.
async function exportAccount() {
  const pw = await askPassword(t('acc_pw_title'), t('acc_pw_export'))
  if (pw === null) return  // cancelled
  try {
    const envelope = pw === ''
      ? buildAccountBackup()
      : await encryptBackup(buildAccountInner(), pw)
    await saveTextFile('telefon-account.json', JSON.stringify(envelope, null, 2))
    toast(t('acc_exported'), 'success')
  } catch (e) { toast(t('import_failed', { err: e }), 'error') }
}

// Restore an account backup (keys + nickname + contacts), then reload. Replacing
// the identity is destructive, so confirm first. Handles both plain (enc:false)
// and encrypted (enc:'aes-gcm') envelopes, and falls back to the legacy
// plain-text contacts format (which is additive, no identity change).
async function importAccountFile(file) {
  const text = await file.text()
  let data = null
  try { data = JSON.parse(text) } catch {}
  if (data && data.type === 'telefon-account') {
    if (data.enc === 'aes-gcm') {
      const pw = await askPassword(t('acc_pw_title'), t('acc_pw_import'))
      if (pw === null) return  // cancelled
      let inner
      try { inner = await decryptBackup(data, pw) }
      catch { toast(t('acc_bad_pw'), 'error'); return }
      window.lui.confirm({
        icon: '⚠️', title: t('account'), text: t('acc_warn_import'),
        danger: true, ok: t('acc_import'), cancel: t('cancel'),
      }, () => applyAccountInner(inner))
      return
    }
    // enc:false (or no enc field) → plain backup. The inner secret fields live
    // at the top level of the envelope.
    window.lui.confirm({
      icon: '⚠️', title: t('account'), text: t('acc_warn_import'),
      danger: true, ok: t('acc_import'), cancel: t('cancel'),
    }, () => applyAccountInner(data))
    return
  }
  // Legacy plain-text contacts: "id qr label" per line (additive).
  let imported = 0
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const m = line.match(/^(\S+)\s+(\S+)(?:\s+(.+))?$/)
    if (!m) continue
    const [, , qr, label] = m
    if (!qr.startsWith('K0')) continue
    try {
      const idU8 = client.addPeerFromQr(qr)
      peerBook[u8hex(idU8)] = { qr, label: label?.trim() || null, online: false }
      imported++
    } catch { /* skip bad entries */ }
  }
  if (imported === 0) { toast(t('acc_bad'), 'error'); return }
  persist(); renderContacts(); subscribeAll()
  toast(t('imported', { n: imported }), 'success')
}

$('import-file').onchange = async (e) => {
  const file = e.target.files[0]
  if (!file) return
  try { await importAccountFile(file) }
  catch (e2) { toast(t('import_failed', { err: e2 }), 'error') }
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

// Delete all chat history (messages, outbox, files) but keep the identity
// (seeds/nickname) and contacts. Clear unread badges too, then reload for a
// clean UI state.
function deleteAllChats() {
  ;(async () => {
    await Storage.wipe()
    for (const k of Object.keys(unread)) delete unread[k]
    persistUnread()
    toast(t('chats_deleted'), 'success')
    setTimeout(() => location.reload(), 500)
  })()
}

// Open the settings window. Built fresh each time so it shows current values.
function openSettings() {
  const lui = window.lui
  const invite   = buildInviteUrl(client.qrText(nickname || ''))
  const shortId  = u8hex(client.myId).slice(0, 8)
  const themeNow = lui.theme()                 // 'auto' | 'light' | 'dark'
  const langNow  = lui.lang()                  // current language code
  const fxNow    = lui.setEffects()            // boolean
  const verNow   = ($('build-tag')?.textContent || '').replace(/^build\s*/, '').trim() || '—'

  // Language picker: code → endonym (each language's own name; not translated).
  const LANG_NAMES = { en: 'English', es: 'Español', zh: '中文', ko: '한국어', fi: 'Suomi', ru: 'Русский', uk: 'Українська' }
  const langOpts = Object.entries(LANG_NAMES)
    .map(([code, name]) => `<option value="${code}">${name}</option>`).join('')

  // Unified layout: every single setting is one .set-line — label on the left,
  // control/value on the right, a thin divider between rows. The invite block
  // keeps its own heading+field (Leonid: "leave the invite construction as is").
  // The account-management group stays a titled block (two grouped actions).
  const html = `
    <div class="set-line">
      <span class="set-label">${escapeHtml(t('set_name'))}</span>
      <span id="set-name-display" class="inline-edit" tabindex="0" role="button" title="${escapeHtml(t('tap_to_edit'))}"></span>
      <input id="set-name" class="input" type="text" maxlength="40" placeholder="${escapeHtml(t('set_name_ph'))}" data-nopersist hidden />
    </div>

    <div class="set-line">
      <span class="set-label">${escapeHtml(t('set_lang'))}</span>
      <span class="select">
        <select id="set-lang" data-nopersist>${langOpts}</select>
      </span>
    </div>

    <div class="set-line">
      <span class="set-label">${escapeHtml(t('set_theme'))}</span>
      <span class="select">
        <select id="set-theme" data-nopersist>
          <option value="auto">${escapeHtml(t('theme_auto'))}</option>
          <option value="light">${escapeHtml(t('theme_light'))}</option>
          <option value="dark">${escapeHtml(t('theme_dark'))}</option>
        </select>
      </span>
    </div>

    <div class="set-line">
      <span class="set-label">${escapeHtml(t('set_effects'))}</span>
      <label class="toggle">
        <input id="set-fx" type="checkbox" data-nopersist />
        <span class="track"></span>
      </label>
    </div>

    <div class="set-line">
      <span class="set-label">${escapeHtml(t('save_chats'))}</span>
      <label class="toggle">
        <input id="set-persist" type="checkbox" data-nopersist />
        <span class="track"></span>
      </label>
    </div>

    <div class="set-line" title="${escapeHtml(t('server_hint'))}">
      <span class="set-label">${escapeHtml(t('set_server'))}</span>
      <span id="set-url-display" class="inline-edit" tabindex="0" role="button" title="${escapeHtml(t('tap_to_edit'))}"></span>
      <input id="set-url" class="input" type="text" data-nopersist hidden />
    </div>

    <div class="set-line">
      <span class="set-label">${escapeHtml(t('update'))}</span>
      <button id="set-update" class="btn btn-ghost">${escapeHtml(t('check_update'))}</button>
    </div>
    <div class="muted set-update-status" id="set-update-status"></div>

    <div class="set-line">
      <span class="set-label">${escapeHtml(t('account'))}</span>
      <button id="set-acc-export" class="btn btn-ghost">${escapeHtml(t('acc_export'))}</button>
      <button id="set-acc-import" class="btn btn-ghost">${escapeHtml(t('acc_import'))}</button>
    </div>

    <div class="set-line">
      <span class="set-label">${escapeHtml(t('blacklist_open'))}</span>
      <button id="set-blacklist" class="btn btn-ghost">${escapeHtml(t('open'))}</button>
    </div>

    <div class="set-line">
      <span class="set-label">${escapeHtml(t('call_log'))}</span>
      <button id="set-calllog" class="btn btn-ghost">${escapeHtml(t('open'))}</button>
    </div>

    <div class="set-sec">
      <h3>${escapeHtml(t('set_invite'))}</h3>
      <input id="set-invite" class="input" type="text" data-copy data-nopersist />
    </div>

    <details class="set-sec set-danger">
      <summary>${escapeHtml(t('account_mgmt'))}</summary>
      <a id="set-del-chats" class="set-wipe-link" role="button" tabindex="0">${escapeHtml(t('del_all_chats'))}</a>
      <a id="set-wipe" class="set-wipe-link" role="button" tabindex="0">${escapeHtml(t('del_account'))}</a>
    </details>`

  const w = lui.win(`${t('settings_title')} · ${shortId}`, html)
  const q = (sel) => w.querySelector(sel)

  // Prefill values.
  q('#set-invite').value = invite
  q('#set-theme').value  = themeNow
  q('#set-lang').value   = langNow
  q('#set-fx').checked   = !!fxNow
  q('#set-persist').checked = chatsPersistEnabled()

  // ── My name (inline edit: shown as text; tap → input; commit on blur/Enter,
  //    no OK button — what you typed is your name) ──
  const nameDisplay = q('#set-name-display')
  const nameInput   = q('#set-name')
  const showNameText = () => {
    nameDisplay.textContent = nickname || t('set_name_ph')
    nameDisplay.hidden = false
    nameInput.hidden = true
  }
  const enterNameEdit = () => {
    nameInput.value = nickname || ''
    nameDisplay.hidden = true
    nameInput.hidden = false
    nameInput.focus()
    try { nameInput.select() } catch {}
  }
  const commitNameEdit = () => {
    const v = nameInput.value.trim()
    if (v && v !== nickname) {
      nickname = v
      saveNickname(v)
      $('my-nickname').textContent = v
      q('#set-invite').value = buildInviteUrl(client.qrText(nickname))
      lui.toast(t('name_updated'))
    }
    showNameText()
  }
  nameDisplay.onclick = enterNameEdit
  nameDisplay.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); enterNameEdit() } }
  nameInput.onblur = commitNameEdit
  nameInput.onkeydown = (e) => {
    if (e.key === 'Enter')      { e.preventDefault(); nameInput.blur() }    // blur → commit
    else if (e.key === 'Escape'){ e.preventDefault(); showNameText() }      // cancel
  }
  showNameText()

  // ── Account ── (the id now rides in the window title; export shows a SECRET-keys
  //    warning in its own confirm dialog, not inline here)
  q('#set-acc-export').onclick = () => { exportAccount() }
  // Import: pick the file first; #import-file.onchange routes to importAccountFile.
  q('#set-acc-import').onclick = () => $('import-file').click()
  // ── Blocked contacts ── open the blacklist window.
  q('#set-blacklist').onclick = () => openBlacklistWindow()
  q('#set-calllog').onclick = () => openCallLogWindow()

  // ── Appearance ──
  q('#set-theme').onchange = (e) => lui.theme(e.target.value)
  q('#set-lang').onchange  = (e) => lui.lang(e.target.value)
  q('#set-fx').onchange    = (e) => {
    const on = e.target.checked
    lui.setEffects(on)
    // Demo the effects right away when turning them ON, so the difference is
    // felt: a sliding toast (motion), a chime (sound) and a buzz (haptics).
    if (on) { lui.sound('ok'); lui.vibrate('ok'); lui.toast(t('effects_on')) }
  }
  // ── Save-chats toggle (ephemeral mode) ──
  // ON (default) → history is persisted to IDB. OFF → ephemeral: nothing is
  // written, chats live only in the open view and vanish on restart.
  q('#set-persist').onchange = (e) => {
    localStorage.setItem('telefon_persist_chats', e.target.checked ? '1' : '0')
  }

  // ── Server config (no buttons: URL is inline-edit, empty = default; any
  //    change persists and reconnects right away with a progress bar) ──
  const dUrl = smartDefaultUrl()
  let reconnecting = false
  const reconnectNow = () => {
    if (reconnecting) return
    reconnecting = true
    lui.toast(t('reconnecting'))
    lui.progress.task().run(900)      // brief bar; the page reloads to reconnect
    setTimeout(() => location.reload(), 800)
  }

  // URL — shown as text with a pencil; empty field uses the default (its
  // placeholder shows exactly what that default is).
  const urlDisplay = q('#set-url-display')
  const urlInput   = q('#set-url')
  urlInput.placeholder = dUrl
  const effectiveUrl = () => (localStorage.getItem('telefon_ws_url') || dUrl)
  const showUrlText = () => {
    urlDisplay.textContent = effectiveUrl()
    urlDisplay.hidden = false
    urlInput.hidden = true
  }
  const editUrl = () => {
    urlInput.value = localStorage.getItem('telefon_ws_url') || ''  // empty → placeholder=default
    urlDisplay.hidden = true
    urlInput.hidden = false
    urlInput.focus(); try { urlInput.select() } catch {}
  }
  const commitUrl = () => {
    const before = effectiveUrl()
    const v = urlInput.value.trim()
    if (v && v !== dUrl) localStorage.setItem('telefon_ws_url', v)
    else                 localStorage.removeItem('telefon_ws_url')   // empty/default → use default
    showUrlText()
    if (effectiveUrl() !== before) reconnectNow()
  }
  urlDisplay.onclick = editUrl
  urlDisplay.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); editUrl() } }
  urlInput.onblur = commitUrl
  urlInput.onkeydown = (e) => {
    if (e.key === 'Enter')       { e.preventDefault(); urlInput.blur() }
    else if (e.key === 'Escape') { e.preventDefault(); showUrlText() }
  }
  showUrlText()

  // ── Update ──
  q('#set-update').onclick = async () => {
    const btn = q('#set-update'), status = q('#set-update-status')
    if (btn.classList.contains('loading')) return
    btn.classList.add('loading')              // brandbook spinner on the button
    status.textContent = ''
    const prog = lui.progress.task().run(2000) // a short progress bar for the wait
    const cur = await installedVersion()        // real installed version (not the #build-tag placeholder)
    let latest = '', failed = false
    try {
      const r = await fetch('https://tele.karlson.ru/apk/version.txt?t=' + Date.now())
      latest = (await r.text()).trim()
    } catch { failed = true }
    prog.done()
    btn.classList.remove('loading')
    if (failed)          { status.textContent = t('update_check_failed'); return }
    if (!latest)         { status.textContent = t('version_not_found'); return }
    if (latest === cur)  { status.textContent = t('up_to_date', { ver: cur }); return }
    status.textContent = t('new_version_avail', { latest })
    if (confirm(t('new_version_q', { latest, cur }))) {
      window.open('https://tele.karlson.ru/apk/telefon-latest.apk?t=' + Date.now(), '_system')
    }
  }

  // ── Danger zone: two guarded actions ──
  // 1) Delete all chats — keeps identity + contacts, wipes only history.
  const askDelChats = () => {
    lui.confirm({
      icon: '🧹', title: t('del_all_chats'), text: t('del_chats_warn'),
      danger: true, ok: t('del_all_chats'), cancel: lui.t('cancel'),
    }, deleteAllChats)
  }
  q('#set-del-chats').onclick = askDelChats
  q('#set-del-chats').onkeydown = (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); askDelChats() }
  }
  // 2) Delete account — full wipe (identity + contacts + history).
  const askWipe = () => {
    lui.confirm({
      icon: '🗑️', title: t('wipe_q'), text: t('del_account_warn'),
      danger: true, ok: t('del_account'), cancel: lui.t('cancel'),
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
// Make the minimized call window draggable across the viewport (tap = expand).
initCallWindowDrag()

// Translate the static markup into the current language now that everything is
// wired. Subsequent language changes are handled by the 'lui:lang' listener up top.
applyI18n()
