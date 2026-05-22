# ws_wasm

WASM crypto module for the `ws.lleo.me` protocol v2. All private keys live
inside WASM memory and never cross the JS↔WASM boundary; JS only sees
ready-to-send byte arrays and parsed incoming objects.

## Build

```bash
./RUN.sh        # wasm-pack build --target web, copies pkg/* into www/
```

Then serve `www/` from any static server, e.g.:

```bash
cd www && python3 -m http.server 8000
# open http://localhost:8000/
```

## API (Rust side, exported via wasm-bindgen)

```rust
WsSession::new()                              // fresh random keypair
WsSession::from_seeds(x_seed, ed_seed)        // deterministic
session.myId()           -> Uint8Array(8)
session.myXPub()         -> Uint8Array(32)
session.myEdPub()        -> Uint8Array(32)
session.qrText()         -> string            // "K0..." 88 chars
session.isEstablished()  -> bool

session.addPeer(x_pub, ed_pub)                -> Uint8Array(8)  // id
session.addPeerFromQr(text)                   -> Uint8Array(8)
session.removePeer(id)
session.hasPeer(id) -> bool

session.buildHandshake() -> Uint8Array        // send as first frame
session.finishHandshake(frame) -> { ok, version, reason? }

session.buildPeerFrame(peer_id, cmd, body, msg_id) -> Uint8Array
session.buildServerFrame(cmd, body, msg_id)        -> Uint8Array
session.parseIncoming(frame) -> { kind, ... }
   // kind: "server" -> { cmd, msg_id, body }
   // kind: "peer"   -> { from_id, cmd, msg_id, body }
   // kind: "error"  -> { reason }
```

## JS glue (`ws_client.js`)

`WsClient` wraps `WsSession` with a `WebSocket` and handles reconnect.
Set `onState`, `onConsole`, `onPeer`, `onServer` callbacks and call
`connect()`. See `index.html` for a full demo.

## Server endpoint (production)

```
ws://ws.lleo.me/api0
```

DNS-only routing (no Cloudflare proxy, no TLS — payload-level encryption
is already end-to-end). See `../ws_server/doc/PROTOCOL.md` for the full
wire format.
