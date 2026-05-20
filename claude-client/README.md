# claude-client — wschat

`wschat` is a generic encrypted-chat bridge over the relay. It connects with
your keypair, introduces itself to one peer (so they see you as a contact),
and then bridges plain text both ways:

- lines from **stdin** (or a watched file) → encrypted `TEXT` to the peer
- incoming `TEXT` from the peer → printed to **stdout** as `<nick>: text`

Any program on the machine can pipe through it to talk to any recipient over
the encrypted service. It was built first as an **AI-agent ↔ human bridge**:
an agent runs `wschat` in the background and exchanges messages with a person
using the same end-to-end-encrypted messenger as everyone else. See
[`CLAUDE.md`](CLAUDE.md) for the agent playbook.

## Generate your keypair + invite

```bash
cargo run --release -- keygen
```

Prints (to stderr):

```
WSCHAT_X_SEED=<hex32>
WSCHAT_ED_SEED=<hex32>
id  = <hex8>
invite (give to peer): K0...
```

Give the `K0...` invite to your peer (so they can add you), and get **their**
`K0...` invite to put in `WSCHAT_PEER_QR`.

## Run

```bash
WSCHAT_X_SEED=<hex32> \
WSCHAT_ED_SEED=<hex32> \
WSCHAT_PEER_QR=K0...<recipient invite> \
WSCHAT_NICK="claude" \
WS_URL=wss://your-relay.example/ws \
WSCHAT_SERVER_X_PUB=<server X25519 public, hex32> \
WSCHAT_SERVER_ED_PUB=<server Ed25519 public, hex32> \
cargo run --release
```

| Env | Required | Default | Meaning |
|-----|----------|---------|---------|
| `WSCHAT_X_SEED` | yes | — | X25519 seed (from `keygen`) |
| `WSCHAT_ED_SEED` | yes | — | Ed25519 seed (from `keygen`) |
| `WSCHAT_PEER_QR` | yes (run) | — | recipient invite, `K0...` |
| `WSCHAT_NICK` | no | `wschat` | your display name |
| `WSCHAT_WATCH` | no | — | poll this file for outgoing lines instead of stdin |
| `WS_URL` | no | built-in | relay WebSocket URL |
| `WSCHAT_SERVER_X_PUB` | no | built-in | relay X25519 public key (hex32) |
| `WSCHAT_SERVER_ED_PUB` | no | built-in | relay Ed25519 public key (hex32) |

The `WSCHAT_SERVER_*` defaults are **public** keys; override them for your
own deployment (see the root README "Generating server keys").

## Limitation

The relay does **not** buffer offline messages. The recipient must be online
when you send, or the message is dropped. `wschat` re-introduces itself
before each send so an offline-then-online peer still learns your keys, but
the text itself is not retried.
