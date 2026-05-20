# web — the PWA

The progressive web app: UI shell, WebRTC voice/video, peer book, and local
key storage. It loads the WASM crypto client (`ws_wasm*`) and talks to the
relay over a single WebSocket. End-to-end encrypted: signalling is AEAD'd by
the WS layer, media is SRTP+DTLS, fingerprints are exchanged through the
encrypted signal channel — the relay/TURN sees only ciphertext.

## Files

```
index.html            UI shell
style.css
app.js                glue: WsClient + CallManager + persistence + DOM
webrtc.js             RTCPeerConnection wrapper, call cmd codes 0x30..0x36
invite.js             ?peer=<qrText> URL helpers
keystore.js           seed + peer-book storage
storage.js            message persistence
DB.js                 IndexedDB layer
sw.js                 service worker
manifest.webmanifest  PWA manifest
ws_client.js          WsClient (from wasm/www)
ws_wasm.js            wasm-bindgen glue (from wasm/www)
ws_wasm_bg.wasm       compiled crypto module (from wasm/www)
sounds/               ringtones
icon-*.png, favicon   app icons
```

The `ws_wasm.js`, `ws_wasm_bg.wasm`, and `ws_client.js` files are produced
by the `wasm/` build (`wasm/RUN.sh`). The copies here are the built output
ready to serve.

## Run

Serve the directory from any static host. `getUserMedia()` (camera/mic)
requires a **secure context**, so:

```bash
# local dev
cd web && python3 -m http.server 8000
# open http://localhost:8000/   (localhost counts as secure)
```

For production you need `https://` for the page **and** `wss://` for the
WebSocket — the same scheme on both, otherwise the browser blocks the WS as
mixed content.

## Identity & invites

Keys live in the WASM session and are persisted locally (seeds + peer book).
An invite link is `<origin>/?peer=K0XXXX...` — the QR text directly. A friend
opens the link, the app reads the param, adds the peer, generates its own
keypair on first launch, then can call. After the first round-trip both
sides know each other and the link is no longer needed.

## Cmd codes (extends `../server/doc/PROTOCOL.md`)

```
0x20 TEXT             body: utf-8                — peer-to-peer chat
0x30 CALL_REQUEST     body: empty
0x31 CALL_ACCEPT      body: empty
0x32 CALL_REJECT      body: empty (or 1B reason)
0x33 CALL_HANGUP      body: empty
0x34 SDP_OFFER        body: utf-8 SDP
0x35 SDP_ANSWER       body: utf-8 SDP
0x36 ICE_CANDIDATE    body: utf-8 JSON candidate
```
