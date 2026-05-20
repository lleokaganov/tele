# server — WebSocket relay

A minimal WebSocket relay for end-to-end encrypted traffic between paired
clients. The relay holds **no users, no database, no auth**. It accepts
opaque ciphertext on one socket and forwards it to the recipient socket,
identified by an 8-byte routing header on the wire. It cannot decrypt the
payloads it relays.

## Protocol

The full wire format — handshake, frame layout, routing-header XOR scheme,
server-originated frames, command codes — is in
[`doc/PROTOCOL.md`](doc/PROTOCOL.md). Read that first; this README only
covers building and running.

## Server keys (required before first build)

This repository ships `src/server_keys.rs.example` with **all-zero
placeholder keys**. The real file `src/server_keys.rs` is `.gitignored`.

```bash
cd src
cp server_keys.rs.example server_keys.rs
# Fill in your own X25519 + Ed25519 keypair and the notifier id.
# See the root README "Generating server keys" for details.
```

The build will fail to link `mod server_keys;` until `src/server_keys.rs`
exists. Clients embed the **public** halves of these keys.

## Build & run

```bash
cargo run --release
```

Configuration via env:

| Var | Default | Meaning |
|-----|---------|---------|
| `WS_BIND` | `0.0.0.0:80` | bind address for the HTTP/WS listener |
| `RUST_LOG` | `ws_server=info,actix=warn` | tracing filter |

Endpoints:

- `GET /ws` — the WebSocket relay (binary frames only).
- `GET /status` — JSON snapshot of current sessions (no secrets).

In production the public path is `/api0` (an nginx-level rewrite to `/ws`);
the transport is plain `ws://` by design, since every payload is already
end-to-end encrypted. See `doc/PROTOCOL.md` for the rationale (and the
note on avoiding Cloudflare proxying for reachability from Russia).

## Reference client & tests

```bash
cargo run --example client      # examples/client.rs — a minimal Rust peer
cargo test                      # includes the server_keys self-consistency
                                # tests (only pass with a real keypair)
```

The release profile is size-optimised (`opt-level = "z"`, LTO) for running
on a Raspberry Pi. `panic = "unwind"` is kept so a bad frame can't take the
whole relay down — actix isolates per-request panics.
