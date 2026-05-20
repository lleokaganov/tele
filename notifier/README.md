# notifier — push gateway

A push gateway for the relay. It connects to the relay as an ordinary
client and does exactly one thing: receive server-forwarded
`WAKE` / `PUSH_REGISTER` commands and turn `WAKE`s into push notifications.

## Privacy design

Clients never talk to the notifier directly and never learn its key. A
client sends `WAKE` / `PUSH_REGISTER` to the **server** (whose public key is
known to everyone); the server decrypts and re-forwards the command to the
notifier, encrypted with the server's own key. So the notifier only ever
knows the server's key — never any client's. It stores `id -> fcm_token`
and nothing else: no client public keys, no message graph.

The notifier's id must be embedded in the relay as `NOTIFIER_ID` so the
relay knows which connected socket to forward those frames to.

The shipped push sender is a stub that logs what it *would* push. Plug a
real FCM (or other) sender into the `PushSender` trait in `src/main.rs`.

## Generate the notifier keypair

```bash
cargo run --release -- keygen
```

It prints something like:

```
# notifier keypair — keep seeds secret, embed id in the server
NOTIFIER_X_SEED=<hex32>
NOTIFIER_ED_SEED=<hex32>
id     = <hex8>
x_pub  = <hex32>
ed_pub = <hex32>

// paste into server_keys.rs:
pub const NOTIFIER_ID: [u8; 8] = [0x.., ...];
```

Copy that `NOTIFIER_ID` line into the relay's `server_keys.rs`, and keep
the two seeds secret (they are the notifier's private identity).

## Run

```bash
NOTIFIER_X_SEED=<hex32> \
NOTIFIER_ED_SEED=<hex32> \
WS_URL=ws://127.0.0.1:8090/ws \
NOTIFIER_SERVER_X_PUB=<server X25519 public, hex32> \
NOTIFIER_SERVER_ED_PUB=<server Ed25519 public, hex32> \
cargo run --release
```

| Env | Required | Default | Meaning |
|-----|----------|---------|---------|
| `NOTIFIER_X_SEED` | yes | — | X25519 seed (from `keygen`) |
| `NOTIFIER_ED_SEED` | yes | — | Ed25519 seed (from `keygen`) |
| `WS_URL` | no | `ws://127.0.0.1:8090/ws` | relay WebSocket URL |
| `NOTIFIER_SERVER_X_PUB` | no | built-in | relay X25519 public key (hex32) |
| `NOTIFIER_SERVER_ED_PUB` | no | built-in | relay Ed25519 public key (hex32) |
| `NOTIFIER_REGISTRY` | no | `notifier_registry.json` | token store path |

The built-in `NOTIFIER_SERVER_*` defaults are public keys; override them to
point at your own deployment (see the root README "Generating server keys").
The registry is flushed atomically (temp file + rename) to survive crashes.
