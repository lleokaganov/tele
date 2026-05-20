# wasm — crypto client

WASM crypto module for the relay protocol (v2), built with `wasm-bindgen`.
All private keys live inside WASM memory and never cross the JS↔WASM
boundary; JS only ever sees ready-to-send byte arrays and parsed incoming
objects. This is the cryptographic core that the `web/` PWA loads.

## Build

```bash
./RUN.sh        # wasm-pack build --target web, copies pkg/* into www/
```

This produces three files in `www/` (and these are what `web/` consumes as
`ws_wasm.js`, `ws_wasm_bg.wasm`, `ws_client.js`):

```
www/ws_wasm.js        wasm-bindgen JS glue
www/ws_wasm_bg.wasm   compiled module
www/ws_client.js      WsClient — WebSocket wrapper around WsSession
```

To try the standalone demo:

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
session.qrText()         -> string            // "K0..." invite
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

## Server keys

The client pins the relay's **public** keys (X25519 + Ed25519). When you
run your own deployment, replace the embedded server public keys with your
own (see the root README "Generating server keys"). The wire format is in
[`../server/doc/PROTOCOL.md`](../server/doc/PROTOCOL.md).
