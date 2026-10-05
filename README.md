# telefon — end-to-end encrypted messenger & calls over a dumb relay

An end-to-end encrypted messenger with voice/video calls. Clients talk to
each other through a **dumb WebSocket relay** that never sees plaintext: it
routes opaque ciphertext by an 8-byte id and nothing more. There are no
accounts, no database, no contact graph on the server.

Crypto primitives, identical on every component:

- **X25519** — ephemeral-static ECDH, one shared secret per peer pair.
- **XChaCha20-Poly1305** — AEAD for every message body (24-byte nonce).
- **Ed25519** — every frame is signed; receivers verify before they decrypt.
- **BLAKE3** — key derivation (`derive_key`) for the routing-header keystream.

## Architecture

```
   client A  <──── encrypted ────>  relay  <──── encrypted ────>  client B
   (keys in     opaque ciphertext  (routes    opaque ciphertext     (keys in
    WASM/app)   + 8-byte route id   by id)     + 8-byte route id     WASM/app)
```

- Each client owns an X25519 + Ed25519 keypair. The 8-byte client **id** is
  the first 8 bytes of its X25519 public key.
- A frame is `[8-byte routing header][24-byte nonce][ciphertext][64-byte sig]`.
  The routing header is the recipient id XOR'd with a BLAKE3-derived
  keystream, so the relay learns *which socket to forward to* but not the
  message, and an observer can't link header to a stable id.
- A routing header that XORs to all-zero means "this frame is for the
  server" (handshake, presence, push routing). Everything else is forwarded
  verbatim to the addressed peer.
- The relay **cannot decrypt** anything it forwards. It only holds a
  long-term keypair so it can run the handshake and sign its own
  server-originated frames; it never sees peer↔peer plaintext.
- Voice/video uses WebRTC: signalling (SDP/ICE) rides the encrypted text
  channel; media is SRTP+DTLS. The relay/TURN sees only ciphertext.

The full wire format is documented in
[`server/doc/PROTOCOL.md`](server/doc/PROTOCOL.md).

## Sections

| Dir | What it is |
|-----|------------|
| [`server/`](server/) | Rust WebSocket relay (actix-web). The dumb router. |
| [`wasm/`](wasm/) | WASM crypto client (wasm-bindgen). All private keys stay inside WASM memory. |
| [`web/`](web/) | The PWA: UI, WebRTC calls, local key storage. Ready to serve. |
| [`android/`](android/) | Capacitor wrapper that packages `web/` as an Android app. |
| [`notifier/`](notifier/) | Push gateway: a separate relay peer that turns WAKE frames into push notifications. |
| [`claude-client/`](claude-client/) | `wschat` — a generic encrypted-chat CLI bridge, plus a guide for AI agents. |

## Build & run

Each section has its own README with details. Quick map:

1. **Generate server keys** (see the next section) — required before the
   relay will build with real identity.
2. **Relay**: `cd server && cargo run --release` — see [`server/README.md`](server/README.md).
3. **WASM client**: `cd wasm && ./RUN.sh` — see [`wasm/README.md`](wasm/README.md).
   This produces the `ws_wasm*.js/.wasm` files that `web/` loads.
4. **Web app**: serve `web/` from any static HTTPS host — see [`web/README.md`](web/README.md).
5. **Android**: `cd android && npx cap sync && cd android && ./gradlew assembleDebug`
   — see [`android/README.md`](android/README.md).
6. **Notifier** (optional push): `cd notifier && cargo run --release` —
   see [`notifier/README.md`](notifier/README.md).
7. **CLI / AI bridge**: `cd claude-client && cargo run --release` —
   see [`claude-client/README.md`](claude-client/README.md) and
   [`claude-client/CLAUDE.md`](claude-client/CLAUDE.md).

## Generating server keys

The relay's long-term keypairs are **not** in this repository. The file
`server/src/server_keys.rs.example` is a placeholder with all-zero keys.
To run your own deployment you generate one keypair, save it as
`server/src/server_keys.rs` (which is `.gitignored`), and the clients embed
the **public** halves.

There is no secret-management magic here: the keys are compiled into the
relay binary, and the public halves are compiled into the clients. The
keypair is permanent for a deployment — rotating it invalidates every
installed client (clients pin the public keys), so generate it once and
keep the private halves safe.

What goes where:

- `X25519_SECRET` / `ED25519_SECRET` — **private**. Compiled into the relay
  only (`server_keys.rs`). Never ship these in a client.
- `X25519_PUBLIC` / `ED25519_PUBLIC` — **public**. Embedded in every client
  (the WASM client, `notifier`, and `wschat` carry them as the
  `SERVER_X_PUB` / `SERVER_ED_PUB` defaults). Safe to publish.
- `NOTIFIER_ID` — the 8-byte id of the push-notifier peer, so the relay
  knows which connected socket to forward WAKE/PUSH_REGISTER frames to.
  Take it from `notifier keygen` (see [`notifier/README.md`](notifier/README.md)).

Steps:

```bash
cd server/src
cp server_keys.rs.example server_keys.rs
# Generate a fresh X25519 + Ed25519 keypair and fill in the four arrays.
# Any tool that emits raw 32-byte X25519 and Ed25519 keys works; the
# notifier/wschat `keygen` subcommands print compatible hex you can
# convert, or write a tiny Rust snippet with x25519-dalek + ed25519-dalek.
# Then propagate the PUBLIC halves into the clients:
#   - wasm/src/lib.rs  (or wherever the client pins server pubs)
#   - notifier:  NOTIFIER_SERVER_X_PUB / NOTIFIER_SERVER_ED_PUB
#   - wschat:    WSCHAT_SERVER_X_PUB   / WSCHAT_SERVER_ED_PUB
```

`server/src/server_keys.rs` stays local and is ignored by git. If you ever
see a non-zero secret in a committed `*.example` file, that's a bug — open
an issue.

## Contributing

Pull requests and issues are welcome, and they do get read. One thing to know before
you open one: **this repository is a mirror, not the source of truth.**

That is deliberate, not an accident of tooling. This is an end-to-end encrypted
messenger — people rely on it for private conversation, and their safety depends on
what the client actually does. A code-hosting account is exactly the kind of thing
that gets compromised. If GitHub were the source, then compromising GitHub, or just
this account, would mean compromising every client built from it. So the authoritative
tree is kept off GitHub, and a publish script pushes snapshots here.

In practice:

- **The green Merge button is not used.** A merge here would be overwritten by the next
  mirror sync — and, more to the point, it would not have passed through the real source.
- **Every change is reviewed by hand and applied in the source tree first.** It shows up
  here on the next publish, and the PR is then closed with a note on what was taken and
  what was not.
- **Authorship is not lost.** The PR remains the public record of who proposed what, and
  its thread says what shipped.
- **Small, single-purpose PRs are easiest to accept.** They are read as patches, so a
  tight diff gets carried over quickly; a broad one gets split, and only the parts that
  survive review ship.

So a closed PR here does not mean "rejected" — read the comment. More often it means
"applied, and already in the published build".

## License & status

This is a reference implementation extracted from a working deployment.
The relay is intentionally minimal; treat the crypto as "audit before you
trust your life to it." Contributions and review welcome.
