// Invite-link helpers. The URL shape is:
//
//   <origin>/?peer=<qrText>
//
// where qrText is the same "K0..." string the WASM session emits via
// `qrText()`. Friends open the link → their app reads the param, adds the
// peer to the local book, generates its own keys if needed and starts
// talking. After the first round-trip the link is no longer needed.

const PARAM = 'peer'

export function buildInviteUrl(qrText) {
  const u = new URL(window.location.href)
  u.search = ''
  u.hash = ''
  u.searchParams.set(PARAM, qrText)
  return u.toString()
}

/** Returns the QR text from `?peer=...` or null. */
export function readInviteFromUrl() {
  const u = new URL(window.location.href)
  return u.searchParams.get(PARAM)
}

/** Strip the invite param from the address bar so a reload doesn't
 *  re-add the peer (it's already in the book). */
export function clearInviteFromUrl() {
  const u = new URL(window.location.href)
  if (!u.searchParams.has(PARAM)) return
  u.searchParams.delete(PARAM)
  history.replaceState(null, '', u.toString())
}
