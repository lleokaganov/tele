//! notifier — push gateway for ws_server.
//!
//! It connects to the relay as an ordinary client (with a keypair whose id
//! is embedded in the server as NOTIFIER_ID) and does ONE thing: receive
//! server-forwarded WAKE / PUSH_REGISTER commands and turn WAKEs into push
//! notifications.
//!
//! Privacy design: clients never talk to the notifier directly and never
//! learn its key. They send WAKE / REGISTER to the *server* (whose key is
//! public), the server decrypts and re-forwards to us encrypted with its
//! own key — so the notifier only ever knows the server's key, never the
//! clients'. It stores `id -> fcm_token`, nothing else (no client public
//! keys, no message graph).
//!
//! Wire (received as server-frames, i.e. routing header XORs to zero):
//!   CMD_PUSH_REGISTER 0x49  body = [sender_id:8][kind:1][token_utf8]
//!   CMD_WAKE          0x48  body = [target_id:8]
//! kind: 1 = FCM available, 0 = none (peer relies on a foreground socket,
//! so it's already online and needs no push).
//!
//! Run modes:
//!   notifier keygen   generate a fresh keypair, print seeds + id + pubs
//!   notifier          run (needs NOTIFIER_X_SEED / NOTIFIER_ED_SEED env)

use std::collections::HashMap;
use std::env;
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use chacha20::ChaCha20;
use chacha20::cipher::{KeyIvInit, StreamCipher};
use chacha20poly1305::{Key, KeyInit, XChaCha20Poly1305, XNonce, aead::Aead};
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use futures_util::{SinkExt, StreamExt};
use rand::RngCore;
use rand::rngs::OsRng;
use serde::{Deserialize, Serialize};
use tokio_tungstenite::tungstenite::Message;
use x25519_dalek::x25519;

const PROTOCOL_VERSION: u8 = 2;

const CMD_HANDSHAKE_REQUEST: u8 = 0x01;
const CMD_HANDSHAKE_OK: u8 = 0x02;
const CMD_WAKE: u8 = 0x48;
const CMD_PUSH_REGISTER: u8 = 0x49;

// Defaults target the ws.lleo.me (Pi) instance; override via env for telefon.
const DEFAULT_SERVER_X_PUB: &str =
    "2beba374aeb45b1220bd06a794dea54bc4484aad0a81dbea9d3d5518da73005b";
const DEFAULT_SERVER_ED_PUB: &str =
    "08d98c12e044d5cacdf54933934c9a4e34f4ce7b3527adbd29a9c0a736f3bf0f";
const DEFAULT_WS_URL: &str = "ws://127.0.0.1:8090/ws";
const DEFAULT_REGISTRY: &str = "notifier_registry.json";

const FLUSH_INTERVAL: Duration = Duration::from_secs(60);
const RECONNECT_DELAY: Duration = Duration::from_secs(5);

// ============================ identity / crypto ============================

#[derive(Clone)]
struct Identity {
    x_priv: [u8; 32],
    x_pub: [u8; 32],
    ed: SigningKey,
    ed_pub: VerifyingKey,
    id: [u8; 8],
}

impl Identity {
    fn from_seeds(x_seed: [u8; 32], ed_seed: [u8; 32]) -> Self {
        let mut x_priv = x_seed;
        x_priv[0] &= 248;
        x_priv[31] &= 127;
        x_priv[31] |= 64;
        let x_pub = x25519(x_priv, x25519_dalek::X25519_BASEPOINT_BYTES);
        let ed = SigningKey::from_bytes(&ed_seed);
        let ed_pub = ed.verifying_key();
        let mut id = [0u8; 8];
        id.copy_from_slice(&x_pub[..8]);
        Self { x_priv, x_pub, ed, ed_pub, id }
    }
}

fn fresh_nonce_24() -> [u8; 24] {
    let mut n = [0u8; 24];
    OsRng.fill_bytes(&mut n);
    n
}

fn aead_encrypt(shared: &[u8; 32], nonce: &[u8; 24], plain: &[u8]) -> Vec<u8> {
    XChaCha20Poly1305::new(Key::from_slice(shared))
        .encrypt(XNonce::from_slice(nonce), plain)
        .expect("aead encrypt")
}

fn aead_decrypt(shared: &[u8; 32], nonce: &[u8; 24], ct: &[u8]) -> Option<Vec<u8>> {
    XChaCha20Poly1305::new(Key::from_slice(shared))
        .decrypt(XNonce::from_slice(nonce), ct)
        .ok()
}

fn xor_header(key: &[u8; 32], nonce_24: &[u8; 24], h: &mut [u8; 8]) {
    let nonce12: [u8; 12] = nonce_24[..12].try_into().unwrap();
    let mut cipher = ChaCha20::new(key.into(), &nonce12.into());
    cipher.apply_keystream(h);
}

fn derive_session(shared: &[u8; 32]) -> ([u8; 32], [u8; 32]) {
    let k_c2s = blake3::derive_key("ws.lleo.me v2 route c2s", shared);
    let k_s2c = blake3::derive_key("ws.lleo.me v2 route s2c", shared);
    (k_c2s, k_s2c)
}

fn pack_inner(message_id: u16, cmd: u8, body: &[u8]) -> Vec<u8> {
    let mut v = Vec::with_capacity(3 + body.len());
    v.extend_from_slice(&message_id.to_le_bytes());
    v.push(cmd);
    v.extend_from_slice(body);
    v
}

fn encrypt_and_sign(
    plain: &[u8],
    my_x_priv: &[u8; 32],
    my_ed: &SigningKey,
    their_x_pub: &[u8; 32],
) -> Vec<u8> {
    let nonce = fresh_nonce_24();
    let shared = x25519(*my_x_priv, *their_x_pub);
    let ct = aead_encrypt(&shared, &nonce, plain);
    let mut packet = Vec::with_capacity(24 + ct.len() + 64);
    packet.extend_from_slice(&nonce);
    packet.extend_from_slice(&ct);
    let sig = my_ed.sign(&packet).to_bytes();
    packet.extend_from_slice(&sig);
    packet
}

fn verify_and_decrypt(
    packet: &[u8],
    my_x_priv: &[u8; 32],
    their_x_pub: &[u8; 32],
    their_ed_pub: &VerifyingKey,
) -> Option<Vec<u8>> {
    if packet.len() < 24 + 16 + 64 {
        return None;
    }
    let (nc, sig) = packet.split_at(packet.len() - 64);
    let sig: &[u8; 64] = sig.try_into().ok()?;
    if their_ed_pub.verify(nc, &Signature::from_bytes(sig)).is_err() {
        return None;
    }
    let nonce: &[u8; 24] = nc[..24].try_into().ok()?;
    let ct = &nc[24..];
    let shared = x25519(*my_x_priv, *their_x_pub);
    aead_decrypt(&shared, nonce, ct)
}

fn build_handshake_request(me: &Identity, server_x_pub: &[u8; 32]) -> Vec<u8> {
    let mut body = Vec::with_capacity(33);
    body.extend_from_slice(me.ed_pub.as_bytes());
    body.push(PROTOCOL_VERSION);
    let inner = pack_inner(0, CMD_HANDSHAKE_REQUEST, &body);
    let packet = encrypt_and_sign(&inner, &me.x_priv, &me.ed, server_x_pub);
    let mut frame = Vec::with_capacity(32 + packet.len());
    frame.extend_from_slice(&me.x_pub);
    frame.extend_from_slice(&packet);
    frame
}

/// Decode a server-originated frame; returns the inner plaintext
/// `[msg_id:2][cmd:1][body]` or None if it isn't a valid server frame.
fn decode_server_frame(
    frame: &[u8],
    k_s2c: &[u8; 32],
    my_x_priv: &[u8; 32],
    server_x_pub: &[u8; 32],
    server_ed: &VerifyingKey,
) -> Option<Vec<u8>> {
    if frame.len() < 8 + 24 + 16 + 64 {
        return None;
    }
    let nonce_24: [u8; 24] = frame[8..32].try_into().ok()?;
    let mut header: [u8; 8] = frame[..8].try_into().ok()?;
    xor_header(k_s2c, &nonce_24, &mut header);
    if header != [0u8; 8] {
        return None; // not a server frame
    }
    verify_and_decrypt(&frame[8..], my_x_priv, server_x_pub, server_ed)
}

// ============================== registry ==============================

#[derive(Serialize, Deserialize, Clone)]
struct Entry {
    token: String,
    kind: u8,
    updated_ms: u64,
}

struct Registry {
    path: PathBuf,
    map: HashMap<String, Entry>, // key = hex(client_id)
    dirty: bool,
}

impl Registry {
    fn load(path: PathBuf) -> Self {
        let map = std::fs::read(&path)
            .ok()
            .and_then(|b| serde_json::from_slice::<HashMap<String, Entry>>(&b).ok())
            .unwrap_or_default();
        tracing::info!("registry loaded: {} entries from {}", map.len(), path.display());
        Self { path, map, dirty: false }
    }

    fn set(&mut self, id: &[u8; 8], kind: u8, token: String) {
        let key = hex::encode(id);
        let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as u64;
        self.map.insert(key, Entry { token, kind, updated_ms: now });
        self.dirty = true;
    }

    fn get(&self, id: &[u8; 8]) -> Option<&Entry> {
        self.map.get(&hex::encode(id))
    }

    fn flush_if_dirty(&mut self) {
        if !self.dirty {
            return;
        }
        match serde_json::to_vec_pretty(&self.map) {
            Ok(bytes) => {
                // Write to a temp file then rename — atomic, and one flash
                // write per flush rather than partial states.
                let tmp = self.path.with_extension("json.tmp");
                if std::fs::write(&tmp, &bytes).is_ok() && std::fs::rename(&tmp, &self.path).is_ok() {
                    self.dirty = false;
                    tracing::debug!("registry flushed: {} entries", self.map.len());
                } else {
                    tracing::warn!("registry flush failed");
                }
            }
            Err(e) => tracing::warn!("registry serialize failed: {e}"),
        }
    }
}

// ============================== push sender ==============================

trait PushSender: Send + Sync {
    fn send(&self, id: &[u8; 8], token: &str);
}

/// Placeholder sender: logs what it would push. Real FCM sender plugs in
/// here once a Firebase project + service-account key exist.
struct StubSender;
impl PushSender for StubSender {
    fn send(&self, id: &[u8; 8], token: &str) {
        tracing::info!("PUSH (stub) → {} token={}…", hex::encode(id), &token[..token.len().min(16)]);
    }
}

// ============================== config ==============================

fn hex32(s: &str) -> [u8; 32] {
    let v = hex::decode(s).expect("hex32 decode");
    v.try_into().expect("hex32 length")
}

fn env_or(name: &str, default: &str) -> String {
    env::var(name).unwrap_or_else(|_| default.to_string())
}

// ============================== main ==============================

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("notifier=info")),
        )
        .compact()
        .init();

    let args: Vec<String> = env::args().collect();
    if args.get(1).map(|s| s.as_str()) == Some("keygen") {
        return keygen();
    }

    let x_seed = hex32(&env::var("NOTIFIER_X_SEED").expect("NOTIFIER_X_SEED env (run `notifier keygen`)"));
    let ed_seed = hex32(&env::var("NOTIFIER_ED_SEED").expect("NOTIFIER_ED_SEED env (run `notifier keygen`)"));
    let me = Identity::from_seeds(x_seed, ed_seed);

    let server_x_pub = hex32(&env_or("NOTIFIER_SERVER_X_PUB", DEFAULT_SERVER_X_PUB));
    let server_ed_pub = hex32(&env_or("NOTIFIER_SERVER_ED_PUB", DEFAULT_SERVER_ED_PUB));
    let server_ed_vk = VerifyingKey::from_bytes(&server_ed_pub).expect("server ed pub");
    let ws_url = env_or("WS_URL", DEFAULT_WS_URL);
    let registry_path = PathBuf::from(env_or("NOTIFIER_REGISTRY", DEFAULT_REGISTRY));

    tracing::info!("notifier id {} connecting to {}", hex::encode(me.id), ws_url);
    tracing::info!("(embed this id in the server as NOTIFIER_ID: {:?})", me.id);

    let mut registry = Registry::load(registry_path);
    let sender: Box<dyn PushSender> = Box::new(StubSender);

    // Reconnect loop.
    loop {
        match run_session(&me, &server_x_pub, &server_ed_vk, &ws_url, &mut registry, sender.as_ref())
            .await
        {
            Ok(()) => tracing::warn!("session ended cleanly; reconnecting"),
            Err(e) => tracing::warn!("session error: {e}; reconnecting in {:?}", RECONNECT_DELAY),
        }
        registry.flush_if_dirty();
        tokio::time::sleep(RECONNECT_DELAY).await;
    }
}

async fn run_session(
    me: &Identity,
    server_x_pub: &[u8; 32],
    server_ed_vk: &VerifyingKey,
    ws_url: &str,
    registry: &mut Registry,
    sender: &dyn PushSender,
) -> anyhow::Result<()> {
    let (mut ws, _) = tokio_tungstenite::connect_async(ws_url).await?;

    ws.send(Message::Binary(build_handshake_request(me, server_x_pub))).await?;

    let shared_with_server = x25519(me.x_priv, *server_x_pub);
    let (_k_c2s, k_s2c) = derive_session(&shared_with_server);

    // Read handshake reply.
    let reply = match ws.next().await {
        Some(Ok(Message::Binary(b))) => b,
        other => anyhow::bail!("unexpected handshake reply: {other:?}"),
    };
    let inner = decode_server_frame(&reply, &k_s2c, &me.x_priv, server_x_pub, server_ed_vk)
        .ok_or_else(|| anyhow::anyhow!("could not decode handshake reply"))?;
    if inner.len() < 3 || inner[2] != CMD_HANDSHAKE_OK {
        anyhow::bail!("handshake rejected: {:?}", inner);
    }
    tracing::info!("handshake OK, listening for WAKE / PUSH_REGISTER");

    let mut flush_timer = tokio::time::interval(FLUSH_INTERVAL);
    flush_timer.tick().await; // consume immediate first tick

    loop {
        tokio::select! {
            msg = ws.next() => {
                match msg {
                    Some(Ok(Message::Binary(b))) => {
                        handle_frame(&b, &k_s2c, me, server_x_pub, server_ed_vk, registry, sender);
                    }
                    Some(Ok(Message::Ping(p))) => { let _ = ws.send(Message::Pong(p)).await; }
                    Some(Ok(Message::Close(_))) | None => {
                        return Ok(());
                    }
                    Some(Err(e)) => anyhow::bail!("ws error: {e}"),
                    _ => {}
                }
            }
            _ = flush_timer.tick() => { registry.flush_if_dirty(); }
            _ = tokio::signal::ctrl_c() => {
                tracing::info!("shutdown signal; flushing registry");
                registry.flush_if_dirty();
                std::process::exit(0);
            }
        }
    }
}

fn handle_frame(
    frame: &[u8],
    k_s2c: &[u8; 32],
    me: &Identity,
    server_x_pub: &[u8; 32],
    server_ed_vk: &VerifyingKey,
    registry: &mut Registry,
    sender: &dyn PushSender,
) {
    let Some(inner) = decode_server_frame(frame, k_s2c, &me.x_priv, server_x_pub, server_ed_vk)
    else {
        // Not a server frame (or undecodable). Clients never address us
        // directly, so anything else is ignored.
        return;
    };
    if inner.len() < 3 {
        return;
    }
    let cmd = inner[2];
    let body = &inner[3..];

    match cmd {
        CMD_PUSH_REGISTER => {
            // [sender_id:8][kind:1][token]
            if body.len() < 9 {
                tracing::warn!("PUSH_REGISTER too short");
                return;
            }
            let id: [u8; 8] = body[..8].try_into().unwrap();
            let kind = body[8];
            let token = String::from_utf8_lossy(&body[9..]).to_string();
            if token.is_empty() {
                tracing::warn!("PUSH_REGISTER empty token for {}", hex::encode(id));
                return;
            }
            registry.set(&id, kind, token);
            tracing::info!("registered {} (kind={})", hex::encode(id), kind);
        }
        CMD_WAKE => {
            // [target_id:8]
            if body.len() < 8 {
                tracing::warn!("WAKE too short");
                return;
            }
            let target: [u8; 8] = body[..8].try_into().unwrap();
            match registry.get(&target) {
                Some(e) if e.kind == 1 => sender.send(&target, &e.token),
                Some(_) => tracing::debug!(
                    "WAKE {} but peer uses foreground socket — no push",
                    hex::encode(target)
                ),
                None => tracing::debug!("WAKE {} but no token registered", hex::encode(target)),
            }
        }
        other => tracing::warn!("unexpected forwarded cmd 0x{other:02x}"),
    }
}

fn keygen() -> anyhow::Result<()> {
    let mut x_seed = [0u8; 32];
    let mut ed_seed = [0u8; 32];
    OsRng.fill_bytes(&mut x_seed);
    OsRng.fill_bytes(&mut ed_seed);
    let me = Identity::from_seeds(x_seed, ed_seed);
    println!("# notifier keypair — keep seeds secret, embed id in the server");
    println!("NOTIFIER_X_SEED={}", hex::encode(x_seed));
    println!("NOTIFIER_ED_SEED={}", hex::encode(ed_seed));
    println!("id     = {}", hex::encode(me.id));
    println!("x_pub  = {}", hex::encode(me.x_pub));
    println!("ed_pub = {}", hex::encode(me.ed_pub.as_bytes()));
    println!();
    println!("// paste into server_keys.rs:");
    let id_bytes = me.id.iter().map(|b| format!("0x{b:02x}")).collect::<Vec<_>>().join(", ");
    println!("pub const NOTIFIER_ID: [u8; 8] = [{id_bytes}];");
    Ok(())
}
