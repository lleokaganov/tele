# ws_server — protocol v2

A minimal WebSocket relay for end-to-end encrypted messages between paired
clients. The server holds no users, no database, no auth. It accepts
opaque ciphertext on one socket and forwards it to the recipient socket,
identified by an 8-byte key on the wire.

## Endpoint

```
ws://ws.lleo.me/api0
```

Plain WebSocket on port 80. The transport is unencrypted by design —
every payload travelling across it is already authenticated and encrypted
end-to-end between the two clients. The server itself cannot decrypt the
relayed payloads.

DNS-only routing (no Cloudflare proxy): `ws.lleo.me` is a CNAME to
`q.lleo.me` which resolves to the server's public IP. Cloudflare tunnels
are intentionally avoided because they are blocked from inside Russia,
where part of the target audience lives.

For local development the server binds `127.0.0.1:8080` (or whatever
`WS_BIND` is set to) and exposes the WebSocket on `/ws` rather than
`/api0`. The `/api0` path is an nginx-level rewrite in production.

## Server identity

Long-term keypairs, hard-coded in the server binary. Clients must embed
the public halves verbatim.

```
X25519  public:  2beba374aeb45b1220bd06a794dea54bc4484aad0a81dbea9d3d5518da73005b
Ed25519 public:  08d98c12e044d5cacdf54933934c9a4e34f4ce7b3527adbd29a9c0a736f3bf0f
```

The server's X25519 key is used to encrypt the client→server handshake
and to encrypt server-originated frames (e.g. delivery errors). The
server's Ed25519 key signs every server-originated frame so clients can
use the same verify-then-decrypt path on every received message.

## Client identity

Every client owns:

  * an X25519 keypair (`x_priv`, `x_pub`) for content encryption, and
  * an Ed25519 keypair (`ed_priv`, `ed_pub`) for content signing.

The client's 8-byte routing id is:

```
client_id = x_pub[..8]
```

X25519 public keys are uniformly random points on curve25519, so the
first 8 bytes are themselves ~64 bits of pseudorandom id — no separate
hash is needed. Two clients whose X keys happen to share the first 8
bytes (≈2⁻⁶⁴ chance) cannot be online simultaneously — the second one
to connect is rejected with `id_in_use`.

Clients must obtain each other's `x_pub` and `ed_pub` out of band
(messenger, manual install, paired device pre-share). The server does
not act as a key directory.

## Cryptographic primitives

  * **X25519** for ECDH (curve25519).
  * **BLAKE3** `derive_key(context, key_material)` to expand the shared
    secret into directional routing keys. Context strings are
    `"ws.lleo.me v2 route c2s"` and `"ws.lleo.me v2 route s2c"`.
  * **XChaCha20-Poly1305** for AEAD (24-byte nonce, 16-byte tag).
  * **ChaCha20** (no Poly1305) as a stream cipher to XOR the 8-byte
    routing header.
  * **Ed25519** for signatures over the AEAD packet
    `(nonce || ciphertext)`.

No SHA-256 anywhere. ClientId is `x_pub[..8]`. KDF is BLAKE3.

## Frame formats

All frames are binary WebSocket messages.

### 1. Handshake request — client → server (first frame on the socket)

```
offset  size  field
------  ----  -----------------------------------------------------------
   0     32   X_client_pub
  32     24   nonce
  56     ..   ciphertext = XChaCha20-Poly1305(
                 key   = X25519(X_client_priv, X_server_pub),
                 nonce = above,
                 plain = handshake_inner,
              ) || tag(16)
  ..     64   Ed25519(ed_client_priv, nonce || ciphertext)
```

Where `handshake_inner` is:

```
[ message_id : u16 LE      ]   set to 0
[ cmd        : u8          ]   = 0x01 (HANDSHAKE_REQUEST)
[ ed_pub     : 32 bytes    ]   client's Ed25519 public key
[ version    : u8          ]   = 0x01
```

The server cannot verify the signature until it has decrypted the
ciphertext and extracted `ed_pub`. AEAD authentication already proves
the sender knows `X_client_priv`; the additional Ed25519 signature is
verified afterwards to keep the verify-then-decrypt code path uniform
across all subsequent frames.

### 2. Handshake reply — server → client

The same shape as a server-originated frame (see §4 below):

```
[ header(8)  = 0x00×8 XOR ChaCha20(K_s2c, nonce[..12])[..8] ]
[ nonce(24)                                                  ]
[ ciphertext(...)  AEAD on shared(X_server, X_client)        ]
[ signature(64)    Ed25519 by the server                     ]
```

`handshake_reply_inner`:

```
[ message_id : u16 LE                ]  = 0
[ cmd        : u8                    ]  = 0x02 (HANDSHAKE_OK)
[ version    : u8                    ]  = 0x01
```

On error the server replies with `cmd = 0xFF` (see §5) and closes the
socket.

### 3. Routing frame — client → server

After a successful handshake every subsequent client frame is a routing
frame:

```
offset  size  field
------  ----  -----------------------------------------------------------
   0      8   recipient_id XOR ChaCha20(K_c2s, nonce[..12])[..8]
   8     24   nonce
  32     ..   ciphertext (opaque to the server)
  ..     64   ed25519 signature (opaque to the server)
```

The `nonce`, `ciphertext`, and `signature` together are the AEAD-signed
packet the recipient will decrypt. Their exact internal layout is
defined by the client-to-client protocol; the server only treats them
as opaque bytes.

The header obfuscation uses ChaCha20 with the same `nonce[..12]` that
prefixes the AEAD payload. Reusing the nonce across two layers is safe
because the keys are different: `K_c2s` is derived from
`shared(X_client, X_server)`, while the AEAD layer uses
`shared(X_sender, X_recipient)`.

`K_c2s` and `K_s2c` are derived once per session:

```
shared = X25519(X_client_priv, X_server_pub)
K_c2s  = BLAKE3.derive_key("ws.lleo.me v2 route c2s", shared)
K_s2c  = BLAKE3.derive_key("ws.lleo.me v2 route s2c", shared)
```

### 4. Routing frame — server → client (delivery)

Identical to §3 except:

  * the header carries `sender_id` XORed against the **recipient's**
    `K_s2c`,
  * the body is passed through unchanged (same nonce, same ciphertext,
    same signature).

### 5. Server message — server → client

A server-originated frame uses `sender_id = 0x00×8` as a marker.

```
offset  size  field
------  ----  -----------------------------------------------------------
   0      8   0x00×8 XOR ChaCha20(K_s2c, nonce[..12])[..8]
   8     24   nonce
  32     ..   ciphertext = XChaCha20-Poly1305(
                 key   = X25519(X_server_priv, X_client_pub),
                 nonce = above,
                 plain = server_inner,
              ) || tag(16)
  ..     64   Ed25519(ed_server_priv, nonce || ciphertext)
```

`server_inner`:

```
[ message_id : u16 LE ]
[ cmd        : u8     ]   0x02 = HANDSHAKE_OK, 0xFF = ERROR
[ body       : ...    ]
```

When the client decrypts a frame whose deobfuscated header is all zeros,
it must verify the signature with the embedded server `ed_pub` (a
hard-coded constant) and then trust the contents.

## Reserved cmd codes

```
0x01    HANDSHAKE_REQUEST   client → server, only in the first frame
0x02    HANDSHAKE_OK        server → client, accepts the session
0x10..0x3F                  user-defined peer-to-peer, opaque to server
0x40    SUBSCRIBE           client → server, body = N × 32-byte X_pub
0x41    UNSUBSCRIBE         client → server, body = N × 32-byte X_pub
0x42    PEER_ONLINE         server → client, body = N × 32-byte X_pub
0x43    PEER_OFFLINE        server → client, body = N × 32-byte X_pub
0x44..0xFE                  reserved
0xFF    ERROR               server → client, see error codes below
```

### Presence: subscribe / unsubscribe

A client tells the server which peers it cares about by sending a
server-bound frame (`recipient_id = 0x00 × 8`) carrying cmd `0x40`. The
inner body is a sequence of full 32-byte X25519 public keys
concatenated end-to-end (N × 32 bytes, any N ≥ 1, including N = 0 as a
no-op).

The server keeps a per-client subscription set. When any peer in the
set comes online (handshake completes) or goes offline (socket
closes), the server pushes a cmd `0x42` / `0x43` server-frame with the
peer's 32-byte X_pub in the body.

On receipt of a fresh `0x40` from a client, the server immediately
replies with one cmd `0x42` frame whose body contains the concatenated
X_pubs of every subscribed peer that is already online — so the
subscriber doesn't have to wait for the next presence change.

`0x41` removes the listed X_pubs from the subscription set. Disconnect
implicitly clears all subscriptions for that client.

## Error codes (cmd = 0xFF)

The first byte of the body is the error code; the remainder is
context-dependent.

```
0x01    id_in_use              body: (none)
0x02    bad_version            body: [ supported_version : u8 ]
0x03    recipient_offline      body: [ target_id : 8 ][ orig_nonce : 24 ]
```

`recipient_offline` references the failed frame by its `target_id` and
the `nonce` that appeared on the wire, so the client can correlate the
error with its outbound traffic.

## State machine

```
                 ┌──────────────────┐
   connect  ───▶ │  AwaitHandshake  │
                 └──────────────────┘
                          │
              first binary frame
                          │
                          ▼
              ┌──────────────────────┐
              │  Verify & register   │── bad → 0xFF error + close
              └──────────────────────┘
                          │
                       success
                          │
                          ▼
                 ┌──────────────────┐
                 │   Established    │── route frames in both directions
                 └──────────────────┘
                          │
              socket close / heartbeat timeout
                          │
                          ▼
                       removed
```

The server times out idle sockets after 60 seconds of silence. It sends
a WebSocket-level Ping every 20 seconds; well-behaved clients reply with
Pong.

## Limits

  * Max frame size: 1 MiB.
  * Routing-frame minimum length: 8 + 24 + 16 + 64 = 112 bytes (empty
    ciphertext).
  * Handshake minimum length: 32 + 24 + 16 + 64 = 136 bytes (empty
    ciphertext).

## Notes for client implementers

The same verify-then-decrypt path covers every received frame:

1. Read the first 8 bytes as `wire_header`.
2. Read the next 24 bytes as `nonce`.
3. The rest is `body || signature` where `signature` is the last 64
   bytes.
4. Compute `header_clear = wire_header XOR ChaCha20(K_s2c, nonce[..12])[..8]`.
   If it equals `0x00×8`, the frame is from the server; otherwise it
   identifies the sender.
5. Look up the sender's `ed_pub` (server's hard-coded key, or peer's
   key from the local address book).
6. Verify the Ed25519 signature over `(nonce || ciphertext)`.
7. Look up the sender's `x_pub` for AEAD; decrypt with
   `shared(X_self_priv, X_sender_pub)`.

Outgoing routing frames are the mirror image: AEAD-sign the inner
payload addressed to the recipient, prepend the 24-byte nonce and the
XOR-obfuscated 8-byte header.
