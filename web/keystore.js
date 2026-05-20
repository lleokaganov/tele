// Persistence for the WsSession seeds. v0 — LocalStorage, plain.
// Later: switch to IndexedDB + WebCrypto AES-GCM wrapping with a user PIN.

const SEED_KEY = 'wsTele.seeds.v1'
const NICK_KEY = 'wsTele.nickname.v1'

export function loadNickname() {
  return localStorage.getItem(NICK_KEY) || null
}
export function saveNickname(s) {
  if (s && s.trim()) localStorage.setItem(NICK_KEY, s.trim())
}
export function wipeNickname() {
  localStorage.removeItem(NICK_KEY)
}

export function loadSeeds() {
  try {
    const raw = localStorage.getItem(SEED_KEY)
    if (!raw) return null
    const obj = JSON.parse(raw)
    const x = b64ToU8(obj.x)
    const ed = b64ToU8(obj.ed)
    if (x.length !== 32 || ed.length !== 32) return null
    return { xSeed: x, edSeed: ed }
  } catch {
    return null
  }
}

export function saveSeeds(xSeed, edSeed) {
  const obj = { x: u8ToB64(xSeed), ed: u8ToB64(edSeed) }
  localStorage.setItem(SEED_KEY, JSON.stringify(obj))
}

export function wipeSeeds() {
  localStorage.removeItem(SEED_KEY)
}

export function generateSeeds() {
  const x = new Uint8Array(32)
  const ed = new Uint8Array(32)
  crypto.getRandomValues(x)
  crypto.getRandomValues(ed)
  return { xSeed: x, edSeed: ed }
}

// Peer book is a separate dict id_hex -> { qr_text, label }.
const PEERS_KEY = 'wsTele.peers.v1'

export function loadPeers() {
  try {
    const raw = localStorage.getItem(PEERS_KEY)
    if (!raw) return {}
    return JSON.parse(raw)
  } catch { return {} }
}

export function savePeers(dict) {
  localStorage.setItem(PEERS_KEY, JSON.stringify(dict))
}

function u8ToB64(u8) {
  let s = ''
  for (const b of u8) s += String.fromCharCode(b)
  return btoa(s)
}

function b64ToU8(s) {
  const dec = atob(s)
  const u8 = new Uint8Array(dec.length)
  for (let i = 0; i < dec.length; i++) u8[i] = dec.charCodeAt(i)
  return u8
}
