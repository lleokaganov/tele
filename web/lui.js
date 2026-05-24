/* ============================================================================
   lui — Lleo UI. Vanilla JS interactive layer (no deps).
   Include:
     <link rel="stylesheet" href="lui.css">
     <script src="lui.js"></script>

   API (window.lui):
     lui.toast(msg)                          — bottom pill notification
     lui.fakeRequest(btnEl)                  — demo: button spinner → toast
     lui.win(title, bodyHTML)                — open a floating window (= openWin)
     lui.closeWin(winEl)                     — close a window
     lui.confirm(opts, onOk)                 — centered modal confirm (= confirmBox)
     lui.progress.task()                     — dynamic top progress bar factory
                                               .set / .run / .flash / .done
     lui.tabs(rootEl)                        — activate a .tabs block (auto on load)
     lui.dropdown(triggerEl, items[])        — context menu under a trigger
     lui.tip.show / lui.tip.hide             — tooltip control (auto via data-tip)

   CSS classes: .btn(.btn-primary/.btn-ghost/.btn-danger), .card, .tile/.tiles,
     .input, .select, .check, .toggle, .tabs/.tab-bar/.tab-panel, .win, .confirm,
     .toast, .progress. Attribute: data-tip="...". Tabs auto-init on DOMContentLoaded.
   ============================================================================ */

const isMobile = () => matchMedia('(max-width: 640px)').matches

// ============================================================================
// i18n — tiny dictionary for lui's OWN component strings (en/ru/uk). Apps can
// extend it via lui.addDict(lang, obj) and look up with lui.t(key, vars).
//   lui.lang()            → current language code
//   lui.lang('ru')        → set + persist (localStorage 'lui-lang'), fires 'lui:lang'
//   lui.t('cancel')       → translated string (current → en → key)
//   lui.t('hi', {name})   → with {name} substitution
//   lui.addDict('ru', {…})→ merge extra strings (app texts)
// ============================================================================
const DICT = {
  en: { copy: 'Copy', copied: 'Copied', cancel: 'Cancel', confirm: 'Confirm',
        ok: 'OK', close: 'Close', update: 'Update', done: 'Done', loading: 'Loading…',
        sure: 'Are you sure?', actions: 'Actions', theme: 'Light / dark theme' },
  ru: { copy: 'Копировать', copied: 'Скопировано', cancel: 'Отмена', confirm: 'Подтвердить',
        ok: 'OK', close: 'Закрыть', update: 'Обновить', done: 'Готово', loading: 'Загрузка…',
        sure: 'Вы уверены?', actions: 'Действия', theme: 'Светлая / тёмная тема' },
  uk: { copy: 'Копіювати', copied: 'Скопійовано', cancel: 'Скасувати', confirm: 'Підтвердити',
        ok: 'OK', close: 'Закрити', update: 'Оновити', done: 'Готово', loading: 'Завантаження…',
        sure: 'Ви впевнені?', actions: 'Дії', theme: 'Світла / темна тема' },
}
const LANGS = ['en', 'ru', 'uk']
function detectLang() {
  const saved = localStorage.getItem('lui-lang')
  if (saved && LANGS.includes(saved)) return saved
  const nav = (navigator.language || 'en').slice(0, 2).toLowerCase()
  return LANGS.includes(nav) ? nav : 'en'
}
let _lang = detectLang()
function t(key, vars) {
  let s = (DICT[_lang] && DICT[_lang][key]) ?? (DICT.en && DICT.en[key]) ?? key
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m))
  return s
}
function lang(code) {
  if (code === undefined) return _lang
  if (!LANGS.includes(code)) return _lang
  _lang = code
  localStorage.setItem('lui-lang', code)
  document.documentElement.lang = code
  try { dispatchEvent(new CustomEvent('lui:lang', { detail: { lang: code } })) } catch {}
  return _lang
}
function addDict(code, obj) {           // apps register their own strings
  DICT[code] = Object.assign(DICT[code] || {}, obj || {})
  if (!LANGS.includes(code)) LANGS.push(code)
}

// ============================================================================
// Accessibility settings: motion / sound / haptics. Each is a boolean stored in
// localStorage. Motion also toggles html.lui-no-motion (CSS kills transitions).
// Setters with no arg act as getters returning the current state.
// ============================================================================
function readFlag(key, dflt) {
  const v = localStorage.getItem(key)
  return v === null ? dflt : v === '1'
}
let _motion  = readFlag('lui-motion', true)    // animations on by default
let _soundOn = readFlag('lui-sound', true)     // sounds on by default
let _haptics = readFlag('lui-haptics', true)   // vibration on by default
function applyMotion() { document.documentElement.classList.toggle('lui-no-motion', !_motion) }
function setMotion(on) {
  if (on === undefined) return _motion
  _motion = !!on
  localStorage.setItem('lui-motion', _motion ? '1' : '0')
  applyMotion()
  return _motion
}
function setSound(on) {
  if (on === undefined) return _soundOn
  _soundOn = !!on
  localStorage.setItem('lui-sound', _soundOn ? '1' : '0')
  return _soundOn
}
function setHaptics(on) {
  if (on === undefined) return _haptics
  _haptics = !!on
  localStorage.setItem('lui-haptics', _haptics ? '1' : '0')
  return _haptics
}
// One switch to rule them all: effects = animations + sounds + haptics together.
// (The three setters above stay for apps that want fine control.)
function setEffects(on) {
  if (on === undefined) return _motion && _soundOn && _haptics
  setMotion(on); setSound(on); setHaptics(on)
  return !!on
}

// ── Ripple on any .btn ───────────────────────────────────────────────────────
document.addEventListener('pointerdown', (e) => {
  const btn = e.target.closest('.btn')
  if (!btn) return
  const r = btn.getBoundingClientRect()
  const s = document.createElement('span')
  s.className = 'ripple'
  const size = Math.max(r.width, r.height)
  s.style.width = s.style.height = size + 'px'
  s.style.left = (e.clientX - r.left - size / 2) + 'px'
  s.style.top  = (e.clientY - r.top  - size / 2) + 'px'
  btn.appendChild(s)
  setTimeout(() => s.remove(), 500)
})

// ── Toast ─────────────────────────────────────────────────────────────────────
let _toastT
function toast(msg) {
  let t = document.querySelector('.toast')
  if (!t) { t = document.createElement('div'); t.className = 'toast'; document.body.appendChild(t) }
  t.textContent = msg
  t.classList.add('on')
  clearTimeout(_toastT)
  _toastT = setTimeout(() => t.classList.remove('on'), 1800)
}

// ── Demo "tap → request lags → spinner → reply" ──────────────────────────────
function fakeRequest(btn) {
  if (btn.classList.contains('loading')) return
  btn.classList.add('loading')
  setTimeout(() => { btn.classList.remove('loading'); toast(t('done') + ' ✓') }, 1100)
}

// ── Windows: equal floating on desktop, modal stack on mobile ────────────────
// DESKTOP: equal floating draggable windows — click raises to top, inactive ones
//   dim, no modal scrim. Unchanged behaviour.
// MOBILE: centered modal stack — each new window dims+blurs everything below it
//   (shared .scrim under the topmost window), no window switching, closed in
//   reverse order via the ✕ or the Android system "back" button. On mobile each
//   openWin pushes a history entry; popstate closes the topmost window.
const WINS = new Set()
const winStack = []                  // open windows, oldest first → top is last
let zSeq = 100                       // like zindexstart in the original
function focusWin(w) {               // raise window to top, others fade (desktop)
  w.style.zIndex = ++zSeq
  WINS.forEach((o) => o.classList.toggle('inactive', o !== w))
}

// On mobile the scrim sits right under the topmost window and blurs everything
// below. Hidden when no windows remain.
const WIN_Z = 600                    // base z-index of windows on mobile (matches CSS)
function updateMobileScrim() {
  const s = scrim()
  if (!winStack.length) { s.classList.remove('on'); return }
  // place each window above the previous one, scrim just under the topmost
  winStack.forEach((w, i) => { w.style.zIndex = WIN_Z + i * 2 })
  s.style.zIndex = WIN_Z + (winStack.length - 1) * 2 - 1
  s.classList.add('on')
}

let _winSeq = 0
function openWin(title, bodyHTML) {
  const mobile = isMobile()
  const w = document.createElement('div')
  w.className = 'win'
  // a11y: a dialog. On mobile it's a modal stack, on desktop equal floating
  // windows (not modal) — only mark aria-modal for the mobile modal case.
  w.setAttribute('role', 'dialog')
  w.setAttribute('tabindex', '-1')
  if (mobile) w.setAttribute('aria-modal', 'true')
  const n = ++_winSeq
  if (!mobile) {                     // light cascade so a new one does not exactly cover the old
    w.style.left = (90 + (n % 6) * 28) + 'px'
    w.style.top  = (84 + (n % 6) * 28) + 'px'
  }
  w.innerHTML = `
    <div class="win-bar">
      <span class="grab"></span>
      <span class="dot"></span>
      <span class="ttl"></span>
      <button type="button" class="x" aria-label="${t('close')}">✕</button>
    </div>
    <div class="win-body"></div>`
  w.querySelector('.ttl').textContent = title
  w.setAttribute('aria-label', title)
  w.querySelector('.win-body').innerHTML = bodyHTML
  w.querySelector('.x').addEventListener('click', (e) => { e.stopPropagation(); closeWin(w) })
  if (!mobile) {          // desktop only: equal floating windows, raise on click + drag.
    w.addEventListener('pointerdown', () => focusWin(w))   // click anywhere → to top
    makeDraggable(w)
  }                       // mobile: centered modal stack, no drag — inner scroll instead.
  document.body.appendChild(w)
  persistRestore(w)        // restore any drafts/state for id'd fields inside this window
  WINS.add(w)
  if (mobile) {
    winStack.push(w)
    updateMobileScrim()
    history.pushState({ lui: true }, '')   // a history entry so system "back" closes this window
    trapFocus(w)                           // mobile windows are modal → trap Tab inside
  } else {
    focusWin(w)
  }
  focusFirst(w)            // a11y: move focus into the freshly opened window
  return w
}

// a11y helpers: list focusable descendants, focus the first, and a modal
// focus-trap (Tab / Shift+Tab cycle within the container, never escaping it).
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), ' +
  'select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
function focusables(root) {
  return [...root.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null || el === root)
}
function focusFirst(root) {
  const els = focusables(root)
  const target = els.find((el) => !el.classList.contains('x')) || els[0] || root
  try { target.focus({ preventScroll: true }) } catch { try { target.focus() } catch {} }
}
function trapFocus(container) {
  const handler = (e) => {
    if (e.key !== 'Tab') return
    if (!document.body.contains(container)) { document.removeEventListener('keydown', handler, true); return }
    const els = focusables(container)
    if (!els.length) { e.preventDefault(); container.focus(); return }
    const first = els[0], last = els[els.length - 1]
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
    else if (!container.contains(document.activeElement)) { e.preventDefault(); first.focus() }
  }
  document.addEventListener('keydown', handler, true)
  container._luiTrap = handler                    // so close can detach it
}
function untrapFocus(container) {
  if (container._luiTrap) { document.removeEventListener('keydown', container._luiTrap, true); container._luiTrap = null }
}
// fromHistory=true → the close was triggered by popstate, so just remove the DOM
// and don't touch history. Otherwise on mobile we let history.back() drive the
// close (its popstate handler does the real removal) to keep history in sync.
function closeWin(w, fromHistory = false) {
  if (!WINS.has(w)) return
  if (isMobile() && !fromHistory) { history.back(); return }
  untrapFocus(w)
  WINS.delete(w)
  const i = winStack.indexOf(w)
  if (i !== -1) winStack.splice(i, 1)
  w.remove()
  if (isMobile()) { updateMobileScrim(); return }
  // desktop: return focus to the topmost remaining (optional, but nice)
  let top = null, z = -1
  WINS.forEach((o) => { const oz = +o.style.zIndex || 0; if (oz > z) { z = oz; top = o } })
  if (top) focusWin(top)
}

// System "back" (Android) / browser back: close the topmost mobile window if any.
// We pushed one history entry per openWin, so each back pops exactly one window.
addEventListener('popstate', () => {
  if (!winStack.length) return
  const top = winStack[winStack.length - 1]
  closeWin(top, true)        // remove directly — history already moved back
})

// drag by titlebar (desktop); window dims while dragging
function makeDraggable(w) {
  const bar = w.querySelector('.win-bar')
  let sx, sy, ox, oy, drag = false
  bar.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.x')) return
    drag = true; w.classList.add('dragging')
    sx = e.clientX; sy = e.clientY
    const r = w.getBoundingClientRect(); ox = r.left; oy = r.top
    // Pin to pixel coords. On mobile the window is centered via translate(-50%,-50%);
    // clear it so left/top don't get shifted again, keeping it under the finger.
    w.style.transform = 'none'
    w.style.right = 'auto'; w.style.bottom = 'auto'
    w.style.left = ox + 'px'; w.style.top = oy + 'px'
    bar.setPointerCapture(e.pointerId)
  })
  bar.addEventListener('pointermove', (e) => {
    if (!drag) return
    w.style.left = (ox + e.clientX - sx) + 'px'
    w.style.top  = (oy + e.clientY - sy) + 'px'
  })
  bar.addEventListener('pointerup', (e) => {
    drag = false; w.classList.remove('dragging')
    try { bar.releasePointerCapture(e.pointerId) } catch {}
  })
}

// ── Centered modal confirm (important actions) ───────────────────────────────
function scrim() {
  let s = document.querySelector('.scrim')
  if (!s) { s = document.createElement('div'); s.className = 'scrim'; document.body.appendChild(s) }
  return s
}
function confirmBox(opts, onOk) {
  // Defaults pulled from the i18n dictionary so the modal speaks the current
  // language unless the caller passes explicit strings.
  const { icon = '⚠️', title = t('sure'), text = '', danger = true,
          ok = t('confirm'), cancel = t('cancel') } = opts || {}
  // Sit above any open windows: scrim/confirm z stack on top of the window layer
  // so the confirm works even when mobile windows are open underneath.
  const base = 700 + (winStack.length ? WIN_Z + winStack.length * 2 : 0)
  const s = scrim(); s.classList.add('on'); s.style.zIndex = base - 10
  const prevFocus = document.activeElement
  const c = document.createElement('div')
  c.className = 'confirm'; c.style.zIndex = base
  c.setAttribute('role', 'dialog')          // a11y: this one is always modal
  c.setAttribute('aria-modal', 'true')
  c.setAttribute('tabindex', '-1')
  c.innerHTML = `
    <div class="head" aria-hidden="true">${icon}</div>
    <h2></h2><p></p>
    <div class="actions">
      <button type="button" class="btn btn-ghost c-cancel"></button>
      <button type="button" class="btn ${danger ? 'btn-danger' : 'btn-primary'} c-ok"></button>
    </div>`
  c.querySelector('h2').textContent = title
  c.querySelector('p').textContent = text
  c.querySelector('.c-cancel').textContent = cancel
  c.querySelector('.c-ok').textContent = ok
  c.setAttribute('aria-label', title)
  const close = () => {
    untrapFocus(c)
    c.remove()
    // Hand the scrim back to the window stack if any windows are still open,
    // otherwise hide it. (Prevents the confirm from killing the windows' blur.)
    if (winStack.length) updateMobileScrim(); else s.classList.remove('on')
    try { prevFocus && prevFocus.focus({ preventScroll: true }) } catch {}
  }
  c.querySelector('.c-cancel').addEventListener('click', close)
  c.querySelector('.c-ok').addEventListener('click', () => { close(); onOk && onOk() })
  s.addEventListener('click', close, { once: true })   // click on backdrop = cancel (fine for confirm)
  document.body.appendChild(c)
  trapFocus(c)                              // modal → trap Tab inside the confirm
  focusFirst(c)                             // move focus into it on open
}

// ── Progress bars: DYNAMIC, one per task, stacked at the top ─────────────────
// Heir of progress() from main.js, but each task is its own bar (not one shared
// bar that jumps). Finished → removed, the rest shift up.
// lui.progress.task() → {set, run, flash, done}.
const progress = (() => {
  const bars = []                          // active bars, drawn stacked
  // Stack upward from the bottom edge, offset by the phone's safe-area inset so
  // the strip/percent don't hide under the home-indicator / gesture bar.
  const SAFE = 'env(safe-area-inset-bottom, 0px)'
  function relayout() { bars.forEach((b, i) => {
    b.el.style.bottom = `calc(${SAFE} + ${i * 4}px)`
    if (b.pctEl) b.pctEl.style.bottom = `calc(${SAFE} + ${4 + i * 4}px)`
  }) }
  function task() {
    const el = document.createElement('div')
    el.className = 'progress'; el.style.width = '0'
    document.body.appendChild(el)
    const b = { el, pctEl: null }
    bars.push(b); relayout()
    let timer = null, dead = false
    function setW(p) { el.style.width = Math.max(0, Math.min(100, p)) + '%' }
    function pct(p, on) {
      if (on) {
        if (!b.pctEl) { b.pctEl = document.createElement('div'); b.pctEl.className = 'pct'; document.body.appendChild(b.pctEl); relayout() }
        b.pctEl.textContent = Math.round(p) + '%'
      } else if (b.pctEl) { b.pctEl.remove(); b.pctEl = null }
    }
    const api = {
      set(p, withPct = true) { if (!dead) { setW(p); pct(p, withPct) } return api },
      // timer-driven: 0→95% over ms (deliberately slower than real), done() finishes it.
      run(ms) {
        const t0 = Date.now()
        timer = setInterval(() => {
          const k = (Date.now() - t0) / ms
          api.set(Math.min(95, k * 95))
          if (k >= 1) clearInterval(timer)
        }, 100)
        return api
      },
      // "sweep": instant reset WITHOUT animation (avoids a jump), then 0→100.
      flash() {
        el.style.transition = 'none'; setW(0); void el.offsetWidth   // reflow — fix at 0
        el.style.transition = 'width .35s ease, opacity .35s'
        requestAnimationFrame(() => { setW(100); setTimeout(api.done, 380) })
        return api
      },
      done() {
        if (dead) return; clearInterval(timer); setW(100)
        setTimeout(() => {
          el.classList.add('done')
          setTimeout(() => {
            dead = true; el.remove(); if (b.pctEl) b.pctEl.remove()
            const i = bars.indexOf(b); if (i !== -1) bars.splice(i, 1); relayout()
          }, 350)
        }, 150)
      }
    }
    return api
  }
  return { task }
})()

// ============================================================================
// TABS — declarative (auto-init by markup) and programmatic (lui.tabs(el)).
// Markup: .tabs > .tab-bar > button[data-tab="id"]  +  .tab-panel[data-panel="id"]
// ============================================================================
function tabs(root) {
  const bar = root.querySelector('.tab-bar')
  if (!bar || bar._luiInit) return
  bar._luiInit = true
  const btns = [...bar.querySelectorAll('[data-tab]')]
  const panels = [...root.querySelectorAll('.tab-panel')]
  // sliding underline indicator
  let ink = bar.querySelector('.tab-ink')
  if (!ink) { ink = document.createElement('span'); ink.className = 'tab-ink'; bar.appendChild(ink) }
  function moveInk(btn) {
    ink.style.left = btn.offsetLeft + 'px'
    ink.style.width = btn.offsetWidth + 'px'
  }
  const canPersist = root.id && !root.hasAttribute('nopersist') && !root.dataset.nopersist
  function activate(id) {
    btns.forEach((b) => b.classList.toggle('active', b.dataset.tab === id))
    panels.forEach((p) => p.classList.toggle('active', p.dataset.panel === id))
    const cur = btns.find((b) => b.dataset.tab === id)
    if (cur) moveInk(cur)
    if (canPersist) localStorage.setItem(PKEY + 'tab:' + root.id, id)   // remember active tab
  }
  btns.forEach((b) => b.addEventListener('click', () => activate(b.dataset.tab)))
  // initial: saved tab → element marked .active → first
  const saved = canPersist ? localStorage.getItem(PKEY + 'tab:' + root.id) : null
  const start = (saved && btns.find((b) => b.dataset.tab === saved)) ||
                btns.find((b) => b.classList.contains('active')) || btns[0]
  if (start) activate(start.dataset.tab)
  // keep underline aligned on resize
  addEventListener('resize', () => {
    const a = btns.find((b) => b.classList.contains('active'))
    if (a) moveInk(a)
  })
  return { activate }
}
function initTabs() { document.querySelectorAll('.tabs').forEach(tabs) }

// ============================================================================
// DROPDOWN MENU — lui.dropdown(triggerEl, items). Opens under the trigger,
// closes on selection or click outside / Escape.
// items: [{ icon, label, danger, onClick }] | { sep: true }
// ============================================================================
let _openMenu = null
function closeMenu() {
  if (_openMenu) { _openMenu.remove(); _openMenu = null }
  document.removeEventListener('pointerdown', _outsideMenu, true)
  document.removeEventListener('keydown', _escMenu, true)
}
function _outsideMenu(e) { if (_openMenu && !_openMenu.contains(e.target)) closeMenu() }
function _escMenu(e) { if (e.key === 'Escape') closeMenu() }

function dropdown(trigger, items) {
  // toggle: clicking the trigger again closes it
  if (_openMenu && _openMenu._owner === trigger) { closeMenu(); return }
  closeMenu()
  const m = document.createElement('div')
  m.className = 'lui-menu'
  m.setAttribute('role', 'menu')
  m._owner = trigger
  items.forEach((it) => {
    if (it.sep) { const s = document.createElement('div'); s.className = 'sep'; s.setAttribute('role', 'separator'); m.appendChild(s); return }
    const row = document.createElement('div')
    row.className = 'item' + (it.danger ? ' danger' : '')
    row.setAttribute('role', 'menuitem')
    row.setAttribute('tabindex', '0')
    row.innerHTML = `<span class="ico"></span><span class="txt"></span>`
    row.querySelector('.ico').textContent = it.icon || ''
    row.querySelector('.txt').textContent = it.label || ''
    row.addEventListener('click', () => { closeMenu(); it.onClick && it.onClick(it) })
    m.appendChild(row)
  })
  document.body.appendChild(m)        // append first so we can measure it
  const r = trigger.getBoundingClientRect()
  const mw = m.offsetWidth, mh = m.offsetHeight
  let left = r.left
  if (left + mw > innerWidth - 8) left = innerWidth - mw - 8     // keep on-screen
  let top = r.bottom + 6
  if (top + mh > innerHeight - 8) top = Math.max(8, r.top - mh - 6)  // flip up if no room below
  m.style.left = Math.max(8, left) + 'px'
  m.style.top = top + 'px'
  _openMenu = m
  // defer outside-listener so the opening click does not immediately close it
  setTimeout(() => {
    document.addEventListener('pointerdown', _outsideMenu, true)
    document.addEventListener('keydown', _escMenu, true)
  }, 0)
  return m
}

// ============================================================================
// TOOLTIP — attribute-driven (data-tip="..."). One delegated handler covers
// hover (desktop) and long-press / tap (mobile). Replaces native title.
// ============================================================================
const tip = (() => {
  // Create + attach eagerly. Lazy-create made the FIRST tap miss: the element
  // had no layout yet, so offsetWidth/Height measured 0 and the bubble was
  // mis-placed/invisible until the second try.
  const el = document.createElement('div'); el.className = 'lui-tip'
  if (document.body) document.body.appendChild(el)
  else addEventListener('DOMContentLoaded', () => document.body.appendChild(el))
  let current = null
  function show(target, text) {
    if (!text) return
    current = target
    const t = el
    t.textContent = text
    t.classList.remove('on', 'above', 'below')
    // measure off-screen first
    t.style.left = '-9999px'; t.style.top = '0'
    const r = target.getBoundingClientRect()
    const tw = t.offsetWidth, th = t.offsetHeight
    let left = r.left + r.width / 2 - tw / 2
    left = Math.max(6, Math.min(left, innerWidth - tw - 6))
    let top, cls
    if (r.top - th - 10 >= 0) { top = r.top - th - 10; cls = 'above' }  // prefer above
    else { top = r.bottom + 10; cls = 'below' }                          // else below
    t.style.left = left + 'px'
    t.style.top = top + 'px'
    // arrow points at the target center, clamped inside the bubble.
    // --ax drives the ::after left (see lui.css .lui-tip::after).
    const ax = Math.max(10, Math.min(r.left + r.width / 2 - left, tw - 10))
    t.style.setProperty('--ax', ax + 'px')
    t.classList.add(cls, 'on')
  }
  function hide() {
    if (el) el.classList.remove('on')
    current = null
  }
  return { show, hide, get current() { return current } }
})()

// desktop hover
document.addEventListener('pointerover', (e) => {
  const el = e.target.closest('[data-tip]')
  if (el && e.pointerType !== 'touch') tip.show(el, el.getAttribute('data-tip'))
})
document.addEventListener('pointerout', (e) => {
  const el = e.target.closest('[data-tip]')
  if (el && e.pointerType !== 'touch') tip.hide()
})
// mobile long-press / tap
let _lp = null
document.addEventListener('pointerdown', (e) => {
  if (e.pointerType !== 'touch') return
  const el = e.target.closest('[data-tip]')
  if (!el) { tip.hide(); return }
  // Show after a short hold (so a tap/scroll doesn't trigger it). The tip then
  // stays visible AS LONG AS the finger is held down.
  _lp = setTimeout(() => tip.show(el, el.getAttribute('data-tip')), 250)
})
document.addEventListener('pointerup',     () => { clearTimeout(_lp); tip.hide() })  // hide the instant the finger lifts
document.addEventListener('pointercancel', () => { clearTimeout(_lp); tip.hide() })
addEventListener('scroll', () => tip.hide(), true)

// ── Persisted UI state ─────────────────────────────────────────────────────────
// Every form control / collapsible with an id remembers its state in
// localStorage and is restored on next load — so the page reopens the way the
// user left it, not at defaults. Opt out with data-nopersist on the element.
const PKEY = 'lui:'
function persistable(el) {
  return el && el.id && !el.hasAttribute('nopersist') && !el.dataset.nopersist
}
function persistSave(el) {
  if (!persistable(el)) return
  const k = PKEY + el.id
  if (el.type === 'checkbox' || el.type === 'radio') localStorage.setItem(k, el.checked ? '1' : '0')
  else if (el.tagName === 'DETAILS') localStorage.setItem(k, el.open ? '1' : '0')
  else localStorage.setItem(k, el.value)
}
function persistRestore(root = document) {            // root lets us restore inside a freshly opened window
  root.querySelectorAll('input[id], select[id], textarea[id]').forEach((el) => {
    if (!persistable(el)) return
    const v = localStorage.getItem(PKEY + el.id)
    if (v === null) return
    if (el.type === 'checkbox' || el.type === 'radio') el.checked = (v === '1')
    else el.value = v
    // No synthetic 'change' here: lui's .check/.toggle/.select are styled via CSS
    // :checked, so visuals update on their own; firing change on load would
    // spuriously trigger app handlers (toasts, theme switches, etc.).
  })
  root.querySelectorAll('details[id]').forEach((d) => {
    if (!persistable(d)) return
    const v = localStorage.getItem(PKEY + d.id); if (v !== null) d.open = (v === '1')
  })
}

// Text fields are saved DEBOUNCED — never on every keystroke (that synchronous
// localStorage write per char is exactly what causes input micro-lag). We write
// ~0.4s after typing stops, off the critical path, plus a guaranteed flush on
// blur / page hide. Checkboxes/selects (rare events) save immediately.
const _saveTimers = new WeakMap()
function persistDebounced(el, ms = 400) {
  clearTimeout(_saveTimers.get(el))
  _saveTimers.set(el, setTimeout(() => persistSave(el), ms))
}
function persistFlush(el) { if (el) { clearTimeout(_saveTimers.get(el)); persistSave(el) } }

document.addEventListener('change', (e) => {          // checkboxes / radios / selects — instant, no lag
  const el = e.target
  if (el.matches?.('select[id]') || ((el.type === 'checkbox' || el.type === 'radio') && el.id)) persistSave(el)
})
document.addEventListener('input', (e) => {           // text — debounced, zero typing lag
  if (e.target.matches?.('input[id][type=text], input[id][type=search], textarea[id]')) persistDebounced(e.target)
})
document.addEventListener('blur', (e) => {            // guarantee: flush on focus loss
  if (e.target.matches?.('input[id], textarea[id]')) persistFlush(e.target)
}, true)
addEventListener('visibilitychange', () => {          // guarantee: flush when leaving/backgrounding
  if (document.hidden) document.querySelectorAll('textarea[id], input[id][type=text], input[id][type=search]').forEach(persistFlush)
})
document.addEventListener('toggle', (e) => {          // <details> collapse state
  if (e.target.matches?.('details[id]')) persistSave(e.target)
}, true)

// Draft API: after a successful op call lui.persist.clear('id') to drop the draft.
const persist = {
  clear(id) { localStorage.removeItem(PKEY + id) },
  get(id) { return localStorage.getItem(PKEY + id) },
  save(elOrId) { persistFlush(typeof elOrId === 'string' ? document.getElementById(elOrId) : elOrId) },
  restore: persistRestore,
}

// ── Haptics: vibration feedback ─────────────────────────────────────────────────
// lui.vibrate('tap'|'ok'|'error'|'warn') or a raw pattern [ms, gap, ms, …].
const VIB = { tap: 12, ok: [12, 50, 12], error: [40, 35, 40, 35, 40], warn: [22, 60, 22] }
function vibrate(p = 'tap') {
  if (!_haptics) return false                 // user disabled haptics (lui.setHaptics(false))
  // Prefer native Capacitor Haptics inside our apps (reliable, like GeoMushrooms);
  // fall back to the browser's navigator.vibrate on the plain web.
  const H = window.Capacitor?.Plugins?.Haptics
  if (H) {
    try {
      if (p === 'ok')        H.notification?.({ type: 'SUCCESS' })
      else if (p === 'error')H.notification?.({ type: 'ERROR' })
      else if (p === 'warn') H.notification?.({ type: 'WARNING' })
      else if (p === 'tap')  H.impact?.({ style: 'LIGHT' })
      else                   H.vibrate?.({ duration: Array.isArray(p) ? (p[0] || 50) : (+p || 50) })
      return true
    } catch {}
  }
  if (!navigator.vibrate) return false
  try { return navigator.vibrate(typeof p === 'string' ? (VIB[p] ?? 12) : p) } catch { return false }
}
// True if any haptic backend is available in this environment.
vibrate.supported = () => !!(window.Capacitor?.Plugins?.Haptics || navigator.vibrate)

// ── Tiny generated sounds (WebAudio, no files) ─────────────────────────────────
// lui.sound('tap'|'ok'|'error'|'notify'). First call needs a user gesture to
// unlock audio on mobile (just call it from a click handler).
let _ac
const SND = {
  tap:    [[600, 0,   0.045, 'sine']],
  ok:     [[660, 0,   0.09,  'sine'], [990, 0.07, 0.13, 'sine']],          // rising
  error:  [[300, 0,   0.13,  'square'], [200, 0.13, 0.20, 'square']],      // low buzz, falling
  notify: [[880, 0,   0.09,  'triangle'], [1320, 0.09, 0.13, 'triangle']],
}
function sound(name = 'tap') {
  if (!_soundOn) return                       // user disabled sounds (lui.setSound(false))
  try {
    _ac = _ac || new (window.AudioContext || window.webkitAudioContext)()
    if (_ac.state === 'suspended') _ac.resume()
    const t0 = _ac.currentTime
    ;(SND[name] || SND.tap).forEach(([freq, at, dur, type]) => {
      const o = _ac.createOscillator(), g = _ac.createGain()
      o.type = type; o.frequency.value = freq
      g.gain.setValueAtTime(0.0001, t0 + at)
      g.gain.exponentialRampToValueAtTime(0.16, t0 + at + 0.008)
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + at + dur)
      o.connect(g); g.connect(_ac.destination)
      o.start(t0 + at); o.stop(t0 + at + dur + 0.02)
    })
  } catch {}
}

// ── Keyboard (desktop): Esc closes top window / cancels confirm; Ctrl/Cmd+Enter
//    in a textarea presses the nearest primary button (submit). Built-in, no setup.
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    const c = document.querySelector('.confirm')          // confirm takes priority
    if (c) { c.querySelector('.c-cancel')?.click(); return }
    if (!WINS.size) return
    let top = winStack.length ? winStack[winStack.length - 1] : null
    if (!top) { let z = -1; WINS.forEach((o) => { const oz = +o.style.zIndex || 0; if (oz > z) { z = oz; top = o } }) }
    if (top) closeWin(top)
    return
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && e.target.tagName === 'TEXTAREA') {
    const scope = e.target.closest('.win, form, .card') || document
    const btn = scope.querySelector('.btn-primary, [data-submit]')
    if (btn) { e.preventDefault(); btn.click() }
  }
})

// ── Boot ──────────────────────────────────────────────────────────────────────
// ── Theme: light / dark / auto (follows OS) ─────────────────────────────────────
function applyTheme() {
  const saved = localStorage.getItem('lui-theme')   // 'dark' | 'light' | null(=auto)
  const dark = saved ? saved === 'dark'
                     : matchMedia('(prefers-color-scheme: dark)').matches
  document.documentElement.dataset.theme = dark ? 'dark' : 'light'
}
function theme(mode) {
  if (mode === undefined) return localStorage.getItem('lui-theme') || 'auto'
  if (mode === 'auto') localStorage.removeItem('lui-theme')
  else localStorage.setItem('lui-theme', mode)
  applyTheme()
}
try { matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (!localStorage.getItem('lui-theme')) applyTheme()      // only when in auto mode
}) } catch {}

function boot() {
  applyTheme()
  applyMotion()                       // honor saved "reduce motion" preference
  document.documentElement.lang = _lang
  initTabs()
  persistRestore()
}
if (document.readyState === 'loading') addEventListener('DOMContentLoaded', boot)
else boot()

// ── Public API ────────────────────────────────────────────────────────────────
window.lui = {
  toast, fakeRequest,
  openWin, win: openWin, closeWin,
  confirmBox, confirm: confirmBox,
  progress,
  tabs, dropdown, tip,
  persist,
  vibrate, sound,
  theme,
  t, lang, addDict,
  setMotion, setSound, setHaptics, setEffects,
}
