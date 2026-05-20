//! WASM crypto bindings for the ws.lleo.me protocol v2.
//!
//! The single exported type `WsSession` owns:
//!
//!   * the local X25519 + Ed25519 keypairs (never leave WASM memory),
//!   * the derived directional session keys K_c2s / K_s2c after handshake,
//!   * an address book of peers (their X_pub + Ed_pub keys).
//!
//! JS interacts via a handful of methods that produce wire bytes or
//! parse incoming frames into native JS objects (`{ kind, cmd, body, ... }`).

use base64::Engine;
use chacha20::ChaCha20;
use chacha20::cipher::{KeyIvInit, StreamCipher};
use chacha20poly1305::{Key, KeyInit, XChaCha20Poly1305, XNonce, aead::Aead};
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use getrandom::getrandom;
use serde::Serialize;
use std::collections::HashMap;
use wasm_bindgen::prelude::*;
use x25519_dalek::{X25519_BASEPOINT_BYTES, x25519};

/* ----------------------------- protocol constants ---------------------- */

const PROTOCOL_VERSION: u8 = 2;

const CMD_HANDSHAKE_REQUEST: u8 = 0x01;
const CMD_HANDSHAKE_OK: u8 = 0x02;
const CMD_INTRODUCE: u8 = 0x46;

/// telefon.lleo.me server identity — independent keys, generated 2026-05-20.
const SERVER_X_PUB: [u8; 32] = [
    0x4e, 0x82, 0x50, 0xd2, 0x8b, 0x9b, 0x28, 0x83, 0x6a, 0xad, 0xf6, 0x49, 0x75, 0x35, 0xef, 0x01,
    0x05, 0x6f, 0x19, 0x98, 0x2d, 0x08, 0xba, 0x40, 0x59, 0xb5, 0xc9, 0x35, 0x37, 0xc8, 0x0f, 0x06,
];
const SERVER_ED_PUB: [u8; 32] = [
    0xb8, 0x35, 0x84, 0x0f, 0xd3, 0xab, 0xa7, 0xcc, 0x45, 0x19, 0x51, 0x3f, 0x3b, 0xbc, 0xb1, 0xc3,
    0x51, 0x70, 0xf6, 0xaa, 0x97, 0xd9, 0x7c, 0x16, 0xea, 0xbd, 0xb2, 0xe3, 0x67, 0x10, 0xd0, 0x03,
];

const QR_PREFIX: &str = "K0";

/* ----------------------------- internal types -------------------------- */

#[derive(Clone)]
struct Peer {
    x_pub: [u8; 32],
    ed_pub: VerifyingKey,
}

/* ----------------------------- exported session ------------------------ */

#[wasm_bindgen]
pub struct WsSession {
    x_priv: [u8; 32],
    x_pub: [u8; 32],
    ed: SigningKey,
    ed_pub: VerifyingKey,

    // Derived eagerly at build_handshake (we need k_s2c to decrypt the
    // very first server frame, the handshake reply). is_established()
    // means "the server replied OK and we are ready to talk", so a
    // separate flag tracks that — distinct from "do we have the keys?".
    k_c2s: Option<[u8; 32]>,
    k_s2c: Option<[u8; 32]>,
    handshake_done: bool,

    // Server identity is fixed across the codebase.
    server_x_pub: [u8; 32],
    server_ed_pub: VerifyingKey,

    // Address book: ClientId (8 bytes = x_pub[..8]) -> Peer.
    peers: HashMap<[u8; 8], Peer>,
}

/* ----------------------------- helpers --------------------------------- */

fn clamp_x_priv(seed: &[u8; 32]) -> [u8; 32] {
    let mut sk = *seed;
    sk[0] &= 248;
    sk[31] &= 127;
    sk[31] |= 64;
    sk
}

fn x_pub_of(priv_: &[u8; 32]) -> [u8; 32] {
    x25519(*priv_, X25519_BASEPOINT_BYTES)
}

fn id_of(x_pub: &[u8; 32]) -> [u8; 8] {
    x_pub[..8].try_into().expect("32 >= 8")
}

fn fresh_nonce_24() -> Result<[u8; 24], JsValue> {
    let mut n = [0u8; 24];
    getrandom(&mut n).map_err(|e| JsValue::from_str(&format!("getrandom: {e}")))?;
    Ok(n)
}

/// XChaCha20-Poly1305 AEAD + Ed25519 signature over (nonce || ciphertext).
/// Returns packet = nonce(24) || ciphertext || sig(64).
fn encrypt_and_sign(
    plain: &[u8],
    my_x_priv: &[u8; 32],
    my_ed: &SigningKey,
    their_x_pub: &[u8; 32],
) -> Result<Vec<u8>, JsValue> {
    let nonce = fresh_nonce_24()?;
    let shared = x25519(*my_x_priv, *their_x_pub);
    let cipher = XChaCha20Poly1305::new(Key::from_slice(&shared));
    let ct = cipher
        .encrypt(XNonce::from_slice(&nonce), plain)
        .map_err(|_| JsValue::from_str("aead encrypt"))?;
    let mut packet = Vec::with_capacity(24 + ct.len() + 64);
    packet.extend_from_slice(&nonce);
    packet.extend_from_slice(&ct);
    let sig = my_ed.sign(&packet).to_bytes();
    packet.extend_from_slice(&sig);
    Ok(packet)
}

/// Verify the Ed25519 signature and decrypt the AEAD body.
fn verify_and_decrypt(
    packet: &[u8],
    my_x_priv: &[u8; 32],
    their_x_pub: &[u8; 32],
    their_ed_pub: &VerifyingKey,
) -> Result<Vec<u8>, JsValue> {
    if packet.len() < 24 + 16 + 64 {
        return Err(JsValue::from_str("frame too short"));
    }
    let (nc, sig_bytes) = packet.split_at(packet.len() - 64);
    let sig_arr: &[u8; 64] = sig_bytes
        .try_into()
        .map_err(|_| JsValue::from_str("bad sig len"))?;
    let sig = Signature::from_bytes(sig_arr);
    their_ed_pub
        .verify(nc, &sig)
        .map_err(|_| JsValue::from_str("bad signature"))?;
    let nonce: &[u8; 24] = nc[..24].try_into().unwrap();
    let ct = &nc[24..];
    let shared = x25519(*my_x_priv, *their_x_pub);
    let cipher = XChaCha20Poly1305::new(Key::from_slice(&shared));
    cipher
        .decrypt(XNonce::from_slice(nonce), ct)
        .map_err(|_| JsValue::from_str("aead decrypt"))
}

/// XOR an 8-byte routing header with a ChaCha20 keystream block (IETF
/// 12-byte nonce taken from `nonce_24[..12]`).
fn xor_header_8(key: &[u8; 32], nonce_24: &[u8; 24], header: &mut [u8; 8]) {
    let nonce12: &[u8; 12] = nonce_24[..12].try_into().unwrap();
    let mut c = ChaCha20::new(key.into(), nonce12.into());
    c.apply_keystream(header);
}

/// `[msg_id:u16 LE][cmd:u8][body...]`
fn pack_inner(msg_id: u16, cmd: u8, body: &[u8]) -> Vec<u8> {
    let mut v = Vec::with_capacity(3 + body.len());
    v.extend_from_slice(&msg_id.to_le_bytes());
    v.push(cmd);
    v.extend_from_slice(body);
    v
}

/* ----------------------------- JS-shaped DTOs -------------------------- */

#[derive(Serialize)]
struct HandshakeResult {
    ok: bool,
    version: u8,
    error_code: u8,
    reason: Option<String>,
}

#[derive(Serialize)]
#[serde(tag = "kind")]
enum Incoming {
    #[serde(rename = "server")]
    Server {
        cmd: u8,
        msg_id: u16,
        body: Vec<u8>,
    },
    #[serde(rename = "peer")]
    Peer {
        from_id: Vec<u8>,
        cmd: u8,
        msg_id: u16,
        body: Vec<u8>,
    },
    #[serde(rename = "error")]
    Error { reason: String },
}

/* ----------------------------- impl WsSession -------------------------- */

#[wasm_bindgen]
impl WsSession {
    /// Generate a fresh keypair-backed session. Use [`WsSession::from_seeds`]
    /// to bootstrap from previously-persisted seeds.
    #[wasm_bindgen(constructor)]
    pub fn new() -> Result<WsSession, JsValue> {
        let mut x_seed = [0u8; 32];
        let mut ed_seed = [0u8; 32];
        getrandom(&mut x_seed).map_err(|e| JsValue::from_str(&format!("getrandom: {e}")))?;
        getrandom(&mut ed_seed).map_err(|e| JsValue::from_str(&format!("getrandom: {e}")))?;
        WsSession::from_seeds(&x_seed, &ed_seed)
    }

    /// Re-create a session from previously-stored seeds (deterministic).
    /// The seeds are themselves the private key material — persist them
    /// only in a secure store (localStorage with caveats, IndexedDB, etc).
    pub fn from_seeds(x_seed: &[u8], ed_seed: &[u8]) -> Result<WsSession, JsValue> {
        let x_seed: [u8; 32] = x_seed
            .try_into()
            .map_err(|_| JsValue::from_str("x_seed must be 32 bytes"))?;
        let ed_seed: [u8; 32] = ed_seed
            .try_into()
            .map_err(|_| JsValue::from_str("ed_seed must be 32 bytes"))?;
        let x_priv = clamp_x_priv(&x_seed);
        let x_pub = x_pub_of(&x_priv);
        let ed = SigningKey::from_bytes(&ed_seed);
        let ed_pub = ed.verifying_key();
        let server_ed_pub = VerifyingKey::from_bytes(&SERVER_ED_PUB)
            .map_err(|_| JsValue::from_str("server ed pub invalid"))?;
        Ok(WsSession {
            x_priv,
            x_pub,
            ed,
            ed_pub,
            k_c2s: None,
            k_s2c: None,
            handshake_done: false,
            server_x_pub: SERVER_X_PUB,
            server_ed_pub,
            peers: HashMap::new(),
        })
    }

    /// Override the relay's public keys (for pointing the app at a
    /// self-hosted server). Defaults are the telefon.lleo.me keys baked in
    /// at from_seeds; call this before connecting to use another relay.
    #[wasm_bindgen(js_name = setServerKeys)]
    pub fn set_server_keys(&mut self, x_pub: &[u8], ed_pub: &[u8]) -> Result<(), JsValue> {
        let xp: [u8; 32] = x_pub
            .try_into()
            .map_err(|_| JsValue::from_str("server x_pub must be 32 bytes"))?;
        let ep_bytes: [u8; 32] = ed_pub
            .try_into()
            .map_err(|_| JsValue::from_str("server ed_pub must be 32 bytes"))?;
        let ep = VerifyingKey::from_bytes(&ep_bytes)
            .map_err(|_| JsValue::from_str("server ed_pub invalid"))?;
        self.server_x_pub = xp;
        self.server_ed_pub = ep;
        Ok(())
    }

    /* ---------- identity getters ---------- */

    #[wasm_bindgen(js_name = myId)]
    pub fn my_id(&self) -> Vec<u8> {
        id_of(&self.x_pub).to_vec()
    }

    #[wasm_bindgen(js_name = myXPub)]
    pub fn my_x_pub(&self) -> Vec<u8> {
        self.x_pub.to_vec()
    }

    #[wasm_bindgen(js_name = myEdPub)]
    pub fn my_ed_pub(&self) -> Vec<u8> {
        self.ed_pub.to_bytes().to_vec()
    }

    /// Compact text payload for embedding in a QR code:
    ///   `"K0" + base64url(x_pub || ed_pub || nickname_utf8)`
    /// Empty nickname → 88 ASCII chars. With nickname the total grows by
    /// roughly 4*ceil(nickname.len()/3) chars.
    #[wasm_bindgen(js_name = qrText)]
    pub fn qr_text(&self, nickname: &str) -> String {
        let nick_bytes = nickname.as_bytes();
        let mut combined = Vec::with_capacity(64 + nick_bytes.len());
        combined.extend_from_slice(&self.x_pub);
        combined.extend_from_slice(self.ed_pub.as_bytes());
        combined.extend_from_slice(nick_bytes);
        let b64 = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(&combined);
        format!("{QR_PREFIX}{b64}")
    }

    /// Returns true only after the server's handshake-OK reply has been
    /// verified. Session keys may have been derived earlier (we need
    /// them to decrypt that very reply), but routing frames must only
    /// be exchanged once this flag is set.
    #[wasm_bindgen(js_name = isEstablished)]
    pub fn is_established(&self) -> bool {
        self.handshake_done
    }

    /* ---------- peer book ---------- */

    /// Add (or replace) a peer in the address book.
    #[wasm_bindgen(js_name = addPeer)]
    pub fn add_peer(&mut self, x_pub: &[u8], ed_pub: &[u8]) -> Result<Vec<u8>, JsValue> {
        let x_pub: [u8; 32] = x_pub
            .try_into()
            .map_err(|_| JsValue::from_str("x_pub must be 32 bytes"))?;
        let ed_pub: [u8; 32] = ed_pub
            .try_into()
            .map_err(|_| JsValue::from_str("ed_pub must be 32 bytes"))?;
        let ed_pub = VerifyingKey::from_bytes(&ed_pub)
            .map_err(|_| JsValue::from_str("ed_pub not on curve"))?;
        let id = id_of(&x_pub);
        self.peers.insert(id, Peer { x_pub, ed_pub });
        Ok(id.to_vec())
    }

    /// Parse a QR text payload and add the resulting peer. Returns the
    /// 8-byte ClientId of the new peer, or throws on malformed input.
    /// (The optional nickname inside the QR is exposed via
    /// `nicknameFromQr` — extracted here only for the address book.)
    #[wasm_bindgen(js_name = addPeerFromQr)]
    pub fn add_peer_from_qr(&mut self, qr_text: &str) -> Result<Vec<u8>, JsValue> {
        let decoded = decode_qr_bytes(qr_text)?;
        self.add_peer(&decoded[..32], &decoded[32..64])
    }

    /// Extract the embedded nickname from a QR text payload. Returns an
    /// empty string if the QR has no nickname (i.e. payload is exactly 64
    /// bytes).
    #[wasm_bindgen(js_name = nicknameFromQr)]
    pub fn nickname_from_qr(qr_text: &str) -> Result<String, JsValue> {
        let decoded = decode_qr_bytes(qr_text)?;
        let tail = &decoded[64..];
        Ok(String::from_utf8_lossy(tail).into_owned())
    }

    #[wasm_bindgen(js_name = removePeer)]
    pub fn remove_peer(&mut self, id: &[u8]) -> Result<(), JsValue> {
        let id: [u8; 8] = id
            .try_into()
            .map_err(|_| JsValue::from_str("id must be 8 bytes"))?;
        self.peers.remove(&id);
        Ok(())
    }

    #[wasm_bindgen(js_name = hasPeer)]
    pub fn has_peer(&self, id: &[u8]) -> bool {
        let Ok(id): Result<[u8; 8], _> = id.try_into() else {
            return false;
        };
        self.peers.contains_key(&id)
    }

    /* ---------- handshake ---------- */

    /// Build the first frame the client must send to the server. After
    /// this call, derive the session keys eagerly so we can both encrypt
    /// the handshake-reply server frame and immediately start encoding
    /// routing frames if the reply is accepted.
    #[wasm_bindgen(js_name = buildHandshake)]
    pub fn build_handshake(&mut self) -> Result<Vec<u8>, JsValue> {
        let mut body = Vec::with_capacity(33);
        body.extend_from_slice(self.ed_pub.as_bytes());
        body.push(PROTOCOL_VERSION);
        let inner = pack_inner(0, CMD_HANDSHAKE_REQUEST, &body);
        let packet = encrypt_and_sign(&inner, &self.x_priv, &self.ed, &self.server_x_pub)?;
        let mut frame = Vec::with_capacity(32 + packet.len());
        frame.extend_from_slice(&self.x_pub);
        frame.extend_from_slice(&packet);

        // Pre-derive session keys; we need k_s2c to decrypt the
        // server's reply frame, which is the very first response.
        let shared = x25519(self.x_priv, self.server_x_pub);
        self.k_c2s = Some(blake3::derive_key("ws.lleo.me v2 route c2s", &shared));
        self.k_s2c = Some(blake3::derive_key("ws.lleo.me v2 route s2c", &shared));
        self.handshake_done = false;
        Ok(frame)
    }

    /// Parse the server's first frame (handshake reply) — same wire shape
    /// as a regular server-message. Returns
    ///   `{ ok: true, version: <server v> }`
    /// or
    ///   `{ ok: false, version: 0, reason: "<msg>" }`.
    /// If the reply is not OK, the session keys are wiped so further
    /// `buildPeerFrame` calls will fail until a new handshake is run.
    #[wasm_bindgen(js_name = finishHandshake)]
    pub fn finish_handshake(&mut self, frame: &[u8]) -> Result<JsValue, JsValue> {
        let inner = match self.decode_server_frame(frame) {
            Ok(p) => p,
            Err(e) => {
                self.k_c2s = None;
                self.k_s2c = None;
                let res = HandshakeResult {
                    ok: false,
                    version: 0,
                    error_code: 0,
                    reason: Some(e.as_string().unwrap_or_default()),
                };
                return Ok(serde_wasm_bindgen::to_value(&res)?);
            }
        };
        if inner.len() < 3 {
            self.k_c2s = None;
            self.k_s2c = None;
            return Err(JsValue::from_str("handshake reply truncated"));
        }
        let cmd = inner[2];
        let version = inner.get(3).copied().unwrap_or(0);
        if cmd == CMD_HANDSHAKE_OK {
            self.handshake_done = true;
            let res = HandshakeResult {
                ok: true,
                version,
                error_code: 0,
                reason: None,
            };
            Ok(serde_wasm_bindgen::to_value(&res)?)
        } else {
            self.k_c2s = None;
            self.k_s2c = None;
            // For cmd=ERROR, body[0] is the error code (ID_IN_USE=1,
            // BAD_VERSION=2, ...). `version` is meaningful only when the
            // server actually told us its version (BAD_VERSION case puts
            // it at body[1]).
            let error_code = inner.get(3).copied().unwrap_or(0);
            let reason = match error_code {
                1 => "ID_IN_USE (another tab/device is using these keys)".to_string(),
                2 => format!("BAD_VERSION (server expects v{})", inner.get(4).copied().unwrap_or(0)),
                _ => format!("error_code=0x{:02x}", error_code),
            };
            let res = HandshakeResult {
                ok: false,
                version,
                error_code,
                reason: Some(reason),
            };
            Ok(serde_wasm_bindgen::to_value(&res)?)
        }
    }

    /* ---------- outbound ---------- */

    /// Build a routing frame addressed to a peer already in the address
    /// book. `body` is the application-level payload (will be wrapped
    /// into the standard `[msg_id][cmd][body]` inner plaintext, AEAD'd
    /// to the peer, signed by us, and obfuscated with K_c2s).
    #[wasm_bindgen(js_name = buildPeerFrame)]
    pub fn build_peer_frame(
        &self,
        peer_id: &[u8],
        cmd: u8,
        body: &[u8],
        msg_id: u16,
    ) -> Result<Vec<u8>, JsValue> {
        let k_c2s = self
            .k_c2s
            .as_ref()
            .ok_or_else(|| JsValue::from_str("handshake not done"))?;
        let id: [u8; 8] = peer_id
            .try_into()
            .map_err(|_| JsValue::from_str("peer_id must be 8 bytes"))?;
        let peer = self
            .peers
            .get(&id)
            .ok_or_else(|| JsValue::from_str("peer not in address book"))?;
        let inner = pack_inner(msg_id, cmd, body);
        let packet = encrypt_and_sign(&inner, &self.x_priv, &self.ed, &peer.x_pub)?;
        let nonce_24: [u8; 24] = packet[..24].try_into().unwrap();
        let mut header = id;
        xor_header_8(k_c2s, &nonce_24, &mut header);
        let mut frame = Vec::with_capacity(8 + packet.len());
        frame.extend_from_slice(&header);
        frame.extend_from_slice(&packet);
        Ok(frame)
    }

    /// Build a server-bound frame (cmd 0x40 SUBSCRIBE, 0x41 UNSUBSCRIBE, …).
    /// `body` is taken as-is (e.g. concatenated 32-byte X pubs for
    /// subscribe / unsubscribe).
    #[wasm_bindgen(js_name = buildServerFrame)]
    pub fn build_server_frame(
        &self,
        cmd: u8,
        body: &[u8],
        msg_id: u16,
    ) -> Result<Vec<u8>, JsValue> {
        let k_c2s = self
            .k_c2s
            .as_ref()
            .ok_or_else(|| JsValue::from_str("handshake not done"))?;
        let inner = pack_inner(msg_id, cmd, body);
        let packet = encrypt_and_sign(&inner, &self.x_priv, &self.ed, &self.server_x_pub)?;
        let nonce_24: [u8; 24] = packet[..24].try_into().unwrap();
        let mut header = [0u8; 8];
        xor_header_8(k_c2s, &nonce_24, &mut header);
        let mut frame = Vec::with_capacity(8 + packet.len());
        frame.extend_from_slice(&header);
        frame.extend_from_slice(&packet);
        Ok(frame)
    }

    /// Ask the server to deliver our public keys to `target_id`. The
    /// optional `nickname` rides along in the same frame and is opaque
    /// to the server. Convenience wrapper around buildServerFrame.
    #[wasm_bindgen(js_name = buildIntroduce)]
    pub fn build_introduce(
        &self,
        target_id: &[u8],
        nickname: &str,
        msg_id: u16,
    ) -> Result<Vec<u8>, JsValue> {
        if target_id.len() != 8 {
            return Err(JsValue::from_str("target_id must be 8 bytes"));
        }
        let nickname_bytes = nickname.as_bytes();
        let mut body = Vec::with_capacity(8 + nickname_bytes.len());
        body.extend_from_slice(target_id);
        body.extend_from_slice(nickname_bytes);
        self.build_server_frame(CMD_INTRODUCE, &body, msg_id)
    }

    /* ---------- inbound ---------- */

    /// Parse a wire frame that just arrived. Returns a JS object:
    ///
    /// * `{ kind: "server", cmd, msg_id, body }` for server-originated.
    /// * `{ kind: "peer",   from_id, cmd, msg_id, body }` for peer relay.
    /// * `{ kind: "error",  reason }` on signature, decrypt or unknown-peer.
    #[wasm_bindgen(js_name = parseIncoming)]
    pub fn parse_incoming(&self, frame: &[u8]) -> Result<JsValue, JsValue> {
        if frame.len() < 8 + 24 + 16 + 64 {
            return self.err("frame too short");
        }
        let k_s2c = match &self.k_s2c {
            Some(k) => k,
            None => return self.err("handshake not done"),
        };
        let nonce_24: [u8; 24] = frame[8..32]
            .try_into()
            .map_err(|_| JsValue::from_str("nonce slice"))?;
        let mut header: [u8; 8] = frame[..8].try_into().unwrap();
        xor_header_8(k_s2c, &nonce_24, &mut header);

        if header == [0u8; 8] {
            // server-originated frame
            let inner = match verify_and_decrypt(
                &frame[8..],
                &self.x_priv,
                &self.server_x_pub,
                &self.server_ed_pub,
            ) {
                Ok(v) => v,
                Err(e) => return self.err(&e.as_string().unwrap_or_else(|| "decrypt".into())),
            };
            return self.ok_server(&inner);
        }

        let peer = match self.peers.get(&header) {
            Some(p) => p.clone(),
            None => return self.err("unknown sender"),
        };
        let inner = match verify_and_decrypt(&frame[8..], &self.x_priv, &peer.x_pub, &peer.ed_pub)
        {
            Ok(v) => v,
            Err(e) => return self.err(&e.as_string().unwrap_or_else(|| "decrypt".into())),
        };
        self.ok_peer(&header, &inner)
    }

    /* ---------- internals --------- */

    fn decode_server_frame(&self, frame: &[u8]) -> Result<Vec<u8>, JsValue> {
        if frame.len() < 8 + 24 + 16 + 64 {
            return Err(JsValue::from_str("frame too short"));
        }
        let k_s2c = self
            .k_s2c
            .as_ref()
            .ok_or_else(|| JsValue::from_str("handshake not done"))?;
        let nonce_24: [u8; 24] = frame[8..32].try_into().unwrap();
        let mut header: [u8; 8] = frame[..8].try_into().unwrap();
        xor_header_8(k_s2c, &nonce_24, &mut header);
        if header != [0u8; 8] {
            return Err(JsValue::from_str("not a server frame"));
        }
        verify_and_decrypt(
            &frame[8..],
            &self.x_priv,
            &self.server_x_pub,
            &self.server_ed_pub,
        )
    }

    fn err(&self, reason: &str) -> Result<JsValue, JsValue> {
        let v = Incoming::Error {
            reason: reason.to_string(),
        };
        Ok(serde_wasm_bindgen::to_value(&v)?)
    }

    fn ok_server(&self, inner: &[u8]) -> Result<JsValue, JsValue> {
        if inner.len() < 3 {
            return self.err("server inner truncated");
        }
        let msg_id = u16::from_le_bytes([inner[0], inner[1]]);
        let cmd = inner[2];
        let body = inner[3..].to_vec();
        let v = Incoming::Server { cmd, msg_id, body };
        Ok(serde_wasm_bindgen::to_value(&v)?)
    }

    fn ok_peer(&self, from_id: &[u8; 8], inner: &[u8]) -> Result<JsValue, JsValue> {
        if inner.len() < 3 {
            return self.err("peer inner truncated");
        }
        let msg_id = u16::from_le_bytes([inner[0], inner[1]]);
        let cmd = inner[2];
        let body = inner[3..].to_vec();
        let v = Incoming::Peer {
            from_id: from_id.to_vec(),
            cmd,
            msg_id,
            body,
        };
        Ok(serde_wasm_bindgen::to_value(&v)?)
    }
}

fn decode_qr_bytes(qr_text: &str) -> Result<Vec<u8>, JsValue> {
    let body = qr_text
        .strip_prefix(QR_PREFIX)
        .ok_or_else(|| JsValue::from_str("not a peer QR (bad prefix)"))?;
    let decoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(body)
        .map_err(|_| JsValue::from_str("base64 decode failed"))?;
    if decoded.len() < 64 {
        return Err(JsValue::from_str("payload truncated"));
    }
    Ok(decoded)
}

/* ----------------------------- free functions (rare paths) -------------- */

/// 32 random bytes from the JS crypto.getRandomValues source.
#[wasm_bindgen]
pub fn seed() -> Vec<u8> {
    let mut s = [0u8; 32];
    let _ = getrandom(&mut s);
    s.to_vec()
}
