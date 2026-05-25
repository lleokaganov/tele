//! wschat — generic encrypted chat bridge over ws_server.
//!
//! Connects to the relay with your keypair, INTRODUCEs yourself to a peer
//! (so they see you as a contact), then bridges:
//!   * lines from stdin (or a --watch file) → encrypted TEXT to the peer
//!   * incoming TEXT from the peer            → printed to stdout
//!
//! Any program on the machine can pipe through it to talk to any recipient
//! over the encrypted service. First user: Claude (agent ↔ telefon bridge).
//!
//! Env:
//!   WSCHAT_X_SEED, WSCHAT_ED_SEED   our keypair seeds (hex32). Required.
//!   WSCHAT_PEER_QR                  recipient invite "K0..." . Required for run.
//!   WSCHAT_NICK                     our display name (default "wschat")
//!   WSCHAT_WATCH                    if set, poll this file for outgoing
//!                                   lines instead of reading stdin
//!   WS_URL                          default wss://telefon.lleo.me/ws
//!   WSCHAT_SERVER_X_PUB / _ED_PUB   default telefon.lleo.me server keys
//!
//! Modes:
//!   wschat keygen   print fresh seeds + your "K0..." invite, then exit
//!   wschat          run the bridge

use std::collections::HashMap;
use std::env;
use std::time::Duration;

use base64::Engine;
use chacha20::ChaCha20;
use chacha20::cipher::{KeyIvInit, StreamCipher};
use chacha20poly1305::{Key, KeyInit, XChaCha20Poly1305, XNonce, aead::Aead};
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use futures_util::{SinkExt, StreamExt};
use rand::RngCore;
use rand::rngs::OsRng;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio_tungstenite::tungstenite::Message;
use x25519_dalek::x25519;

const PROTOCOL_VERSION: u8 = 2;
const QR_PREFIX: &str = "K0";

const CMD_HANDSHAKE_REQUEST: u8 = 0x01;
const CMD_HANDSHAKE_OK: u8 = 0x02;
const CMD_TEXT: u8 = 0x20;
const CMD_DELIVERY_ACK: u8 = 0x27;
const CMD_READ_ACK: u8 = 0x2A;
const CMD_SUBSCRIBE: u8 = 0x40;
const CMD_PEER_ONLINE: u8 = 0x42;
const CMD_INTRODUCE: u8 = 0x46;
const CMD_WAKE: u8 = 0x48;

const DEFAULT_SERVER_X_PUB: &str =
    "4e8250d28b9b28836aadf6497535ef01056f19982d08ba4059b5c93537c80f06";
const DEFAULT_SERVER_ED_PUB: &str =
    "b835840fd3aba7cc4519513f3bbcb1c35170f6aa97d97c16eabdb2e36710d003";
const DEFAULT_WS_URL: &str = "wss://telefon.lleo.me/ws";

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

fn encrypt_and_sign(plain: &[u8], my_x_priv: &[u8; 32], my_ed: &SigningKey, their_x_pub: &[u8; 32]) -> Vec<u8> {
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

fn verify_and_decrypt(packet: &[u8], my_x_priv: &[u8; 32], their_x_pub: &[u8; 32], their_ed_pub: &VerifyingKey) -> Option<Vec<u8>> {
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

/// Build a peer-routed frame: [header = peer_id XOR k_c2s][encrypted packet].
fn build_peer_frame(me: &Identity, peer_x_pub: &[u8; 32], peer_id: &[u8; 8], k_c2s: &[u8; 32], inner: &[u8]) -> Vec<u8> {
    let packet = encrypt_and_sign(inner, &me.x_priv, &me.ed, peer_x_pub);
    let nonce_24: [u8; 24] = packet[..24].try_into().unwrap();
    let mut header = *peer_id;
    xor_header(k_c2s, &nonce_24, &mut header);
    let mut frame = Vec::with_capacity(8 + packet.len());
    frame.extend_from_slice(&header);
    frame.extend_from_slice(&packet);
    frame
}

/// Build a server-routed frame (header XORs to zero on the server side).
fn build_server_bound(me: &Identity, server_x_pub: &[u8; 32], k_c2s: &[u8; 32], inner: &[u8]) -> Vec<u8> {
    let packet = encrypt_and_sign(inner, &me.x_priv, &me.ed, server_x_pub);
    let nonce_24: [u8; 24] = packet[..24].try_into().unwrap();
    let mut header = [0u8; 8];
    xor_header(k_c2s, &nonce_24, &mut header);
    let mut frame = Vec::with_capacity(8 + packet.len());
    frame.extend_from_slice(&header);
    frame.extend_from_slice(&packet);
    frame
}

// ============================== qr / config ==============================

fn hex32(s: &str) -> [u8; 32] {
    hex::decode(s).expect("hex32 decode").try_into().expect("hex32 length")
}

fn env_or(name: &str, default: &str) -> String {
    env::var(name).unwrap_or_else(|_| default.to_string())
}

struct Peer {
    x_pub: [u8; 32],
    ed_pub: VerifyingKey,
    id: [u8; 8],
    nick: String,
}

/// An outgoing message in the local outbox. Kept until the peer's
/// delivery-ack arrives; re-sent when the peer comes online.
struct OutMsg {
    text: String,
    delivered: bool,
}

fn decode_qr(qr: &str) -> anyhow::Result<Peer> {
    let body = qr.strip_prefix(QR_PREFIX).ok_or_else(|| anyhow::anyhow!("bad QR prefix"))?;
    let raw = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(body)?;
    if raw.len() < 64 {
        anyhow::bail!("QR too short");
    }
    let x_pub: [u8; 32] = raw[..32].try_into().unwrap();
    let ed_pub = VerifyingKey::from_bytes(&raw[32..64].try_into().unwrap())?;
    let mut id = [0u8; 8];
    id.copy_from_slice(&x_pub[..8]);
    let nick = String::from_utf8_lossy(&raw[64..]).to_string();
    Ok(Peer { x_pub, ed_pub, id, nick })
}

fn make_qr(me: &Identity, nick: &str) -> String {
    let mut combined = Vec::with_capacity(64 + nick.len());
    combined.extend_from_slice(&me.x_pub);
    combined.extend_from_slice(me.ed_pub.as_bytes());
    combined.extend_from_slice(nick.as_bytes());
    format!("{QR_PREFIX}{}", base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(&combined))
}

// ============================== main ==============================

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args: Vec<String> = env::args().collect();
    let nick = env_or("WSCHAT_NICK", "wschat");

    if args.get(1).map(|s| s.as_str()) == Some("keygen") {
        let mut x_seed = [0u8; 32];
        let mut ed_seed = [0u8; 32];
        OsRng.fill_bytes(&mut x_seed);
        OsRng.fill_bytes(&mut ed_seed);
        let me = Identity::from_seeds(x_seed, ed_seed);
        eprintln!("WSCHAT_X_SEED={}", hex::encode(x_seed));
        eprintln!("WSCHAT_ED_SEED={}", hex::encode(ed_seed));
        eprintln!("id  = {}", hex::encode(me.id));
        eprintln!("invite (give to peer): {}", make_qr(&me, &nick));
        return Ok(());
    }

    // `wschat wake <id-hex16>` — send one server-bound WAKE for an offline
    // peer (by 8-byte client id) and exit. Used to test/trigger push without
    // needing the peer's invite (WAKE only carries the target id).
    if args.get(1).map(|s| s.as_str()) == Some("wake") {
        let is_call = args.get(3).map(|s| s.as_str()) == Some("call");
        return wake_mode(args.get(2).map(|s| s.as_str()).unwrap_or(""), is_call).await;
    }

    // Seeds are optional: if absent, generate a fresh per-session keypair.
    // That gives each bridge session its own identity (so several can run in
    // parallel as distinct contacts), named via WSCHAT_NICK.
    let me = match (env::var("WSCHAT_X_SEED").ok(), env::var("WSCHAT_ED_SEED").ok()) {
        (Some(x), Some(e)) => Identity::from_seeds(hex32(&x), hex32(&e)),
        _ => {
            let mut x = [0u8; 32];
            let mut ed = [0u8; 32];
            OsRng.fill_bytes(&mut x);
            OsRng.fill_bytes(&mut ed);
            eprintln!("[wschat] fresh session identity (no seeds in env)");
            Identity::from_seeds(x, ed)
        }
    };
    let peer = decode_qr(&env::var("WSCHAT_PEER_QR").expect("WSCHAT_PEER_QR (recipient invite)"))?;
    let server_x_pub = hex32(&env_or("WSCHAT_SERVER_X_PUB", DEFAULT_SERVER_X_PUB));
    let server_ed_pub = hex32(&env_or("WSCHAT_SERVER_ED_PUB", DEFAULT_SERVER_ED_PUB));
    let server_ed_vk = VerifyingKey::from_bytes(&server_ed_pub).expect("server ed pub");
    let ws_url = env_or("WS_URL", DEFAULT_WS_URL);
    let watch = env::var("WSCHAT_WATCH").ok();

    eprintln!("[wschat] me={} nick={} → peer={} ({})", hex::encode(me.id), nick, hex::encode(peer.id), peer.nick);
    eprintln!("[wschat] my invite: {}", make_qr(&me, &nick));

    let shared_with_server = x25519(me.x_priv, server_x_pub);
    let (k_c2s, k_s2c) = derive_session(&shared_with_server);

    // State persists across reconnects.
    let mut seq: u16 = 1;
    let mut sent: HashMap<[u8; 16], OutMsg> = HashMap::new();
    let mut watch_offset: u64 = watch
        .as_ref()
        .and_then(|p| std::fs::metadata(p).ok())
        .map(|m| m.len())
        .unwrap_or(0); // only send lines appended after we start
    let mut stdin_lines = (watch.is_none()).then(|| BufReader::new(tokio::io::stdin()).lines());

    'reconnect: loop {
        // (Re)connect + handshake. On any failure, wait and retry — the
        // bridge must survive relay restarts / network blips, otherwise it
        // silently dies and messages are lost.
        let mut ws = match tokio_tungstenite::connect_async(&ws_url).await {
            Ok((ws, _)) => ws,
            Err(e) => {
                eprintln!("[wschat] connect failed: {e}; retry in 5s");
                tokio::select! {
                    _ = tokio::time::sleep(Duration::from_secs(5)) => continue 'reconnect,
                    _ = tokio::signal::ctrl_c() => break 'reconnect,
                }
            }
        };
        if ws.send(Message::Binary(build_handshake_request(&me, &server_x_pub))).await.is_err() {
            eprintln!("[wschat] handshake send failed; retry in 5s");
            tokio::time::sleep(Duration::from_secs(5)).await;
            continue 'reconnect;
        }
        let ok = matches!(ws.next().await,
            Some(Ok(Message::Binary(b)))
                if decode_server_frame(&b, &k_s2c, &me.x_priv, &server_x_pub, &server_ed_vk)
                    .map(|i| i.len() >= 3 && i[2] == CMD_HANDSHAKE_OK).unwrap_or(false));
        if !ok {
            eprintln!("[wschat] handshake failed; retry in 5s");
            tokio::time::sleep(Duration::from_secs(5)).await;
            continue 'reconnect;
        }
        eprintln!("[wschat] connected. introducing self to peer…");

        // Introduce ourselves so the peer gets our keys + nick as a contact.
        let mut intro_body = Vec::with_capacity(8 + nick.len());
        intro_body.extend_from_slice(&peer.id);
        intro_body.extend_from_slice(nick.as_bytes());
        let _ = ws.send(Message::Binary(
            build_server_bound(&me, &server_x_pub, &k_c2s, &pack_inner(seq, CMD_INTRODUCE, &intro_body))
        )).await;
        seq = seq.wrapping_add(1);

        // Subscribe to the peer's presence so PEER_ONLINE wakes the outbox.
        let _ = ws.send(Message::Binary(
            build_server_bound(&me, &server_x_pub, &k_c2s, &pack_inner(seq, CMD_SUBSCRIBE, &peer.x_pub))
        )).await;
        seq = seq.wrapping_add(1);

        // Peer may already be online — try to flush any pending outbox now.
        flush_outbox(&me, &peer, &nick, &k_c2s, &server_x_pub, &mut ws, &mut seq, &mut sent).await;

        let mut poll = tokio::time::interval(Duration::from_millis(500));
        // Liveness: the server emits a frame (binary, WS-ping, or plain-text "ping")
        // at least every ~20s. If we see NOTHING for >50s the socket has silently
        // gone dead (NAT drop / sleep) without a close event — force a reconnect.
        let mut liveness = tokio::time::interval(Duration::from_secs(10));
        let mut last_rx = std::time::Instant::now();
        eprintln!("[wschat] ready. type/append lines to send; incoming prints below.");

        loop {
            tokio::select! {
                msg = ws.next() => {
                    if matches!(msg, Some(Ok(_))) { last_rx = std::time::Instant::now(); }
                    match msg {
                        Some(Ok(Message::Binary(b))) => {
                            handle_incoming(&b, &me, &peer, &nick, &k_s2c, &k_c2s, &server_x_pub, &server_ed_vk, &mut ws, &mut seq, &mut sent).await;
                        }
                        Some(Ok(Message::Text(t))) => {
                            // Server's plain-text keepalive; reply "pong". Any received
                            // frame already refreshed last_rx above.
                            if t == "ping" { let _ = ws.send(Message::Text("pong".to_string())).await; }
                        }
                        Some(Ok(Message::Ping(p))) => { let _ = ws.send(Message::Pong(p)).await; }
                        Some(Ok(Message::Close(_))) | None => {
                            eprintln!("[wschat] connection closed; reconnecting in 3s");
                            break;
                        }
                        Some(Err(e)) => { eprintln!("[wschat] ws error: {e}; reconnecting in 3s"); break; }
                        _ => {}
                    }
                }
                line = async { stdin_lines.as_mut().unwrap().next_line().await }, if stdin_lines.is_some() => {
                    match line {
                        Ok(Some(text)) if !text.trim().is_empty() => {
                            send_text(&text, &me, &peer, &nick, &k_c2s, &server_x_pub, &mut ws, &mut seq, &mut sent).await;
                        }
                        Ok(Some(_)) => {}
                        _ => { stdin_lines = None; }
                    }
                }
                _ = poll.tick(), if watch.is_some() => {
                    if let Some(path) = watch.as_ref() {
                        for text in read_new_lines(path, &mut watch_offset) {
                            if !text.trim().is_empty() {
                                send_text(&text, &me, &peer, &nick, &k_c2s, &server_x_pub, &mut ws, &mut seq, &mut sent).await;
                            }
                        }
                    }
                }
                _ = liveness.tick() => {
                    if last_rx.elapsed() > Duration::from_secs(50) {
                        eprintln!("[wschat] no frames for >50s — link dead, reconnecting");
                        break;
                    }
                }
                _ = tokio::signal::ctrl_c() => { let _ = ws.close(None).await; break 'reconnect; }
            }
        }
        let _ = ws.close(None).await;
        tokio::time::sleep(Duration::from_secs(3)).await;
    }
    Ok(())
}

type Ws = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// Connect, handshake, send one WAKE for `target_hex` (8-byte client id),
/// then exit. The relay forwards it to the notifier, which pushes the peer.
async fn wake_mode(target_hex: &str, is_call: bool) -> anyhow::Result<()> {
    let raw = hex::decode(target_hex.trim()).map_err(|_| anyhow::anyhow!("bad target hex"))?;
    if raw.len() != 8 {
        anyhow::bail!("target must be 8 bytes (16 hex chars), got {}", raw.len());
    }
    let target: [u8; 8] = raw.try_into().unwrap();

    // A WAKE doesn't need a stable identity — use a throwaway keypair.
    let mut x = [0u8; 32];
    let mut ed = [0u8; 32];
    OsRng.fill_bytes(&mut x);
    OsRng.fill_bytes(&mut ed);
    let me = Identity::from_seeds(x, ed);

    let server_x_pub = hex32(&env_or("WSCHAT_SERVER_X_PUB", DEFAULT_SERVER_X_PUB));
    let server_ed_pub = hex32(&env_or("WSCHAT_SERVER_ED_PUB", DEFAULT_SERVER_ED_PUB));
    let server_ed_vk = VerifyingKey::from_bytes(&server_ed_pub).expect("server ed pub");
    let ws_url = env_or("WS_URL", DEFAULT_WS_URL);

    let (mut ws, _) = tokio_tungstenite::connect_async(&ws_url).await?;
    ws.send(Message::Binary(build_handshake_request(&me, &server_x_pub))).await?;
    let shared = x25519(me.x_priv, server_x_pub);
    let (k_c2s, k_s2c) = derive_session(&shared);
    let ok = matches!(ws.next().await,
        Some(Ok(Message::Binary(b)))
            if decode_server_frame(&b, &k_s2c, &me.x_priv, &server_x_pub, &server_ed_vk)
                .map(|i| i.len() >= 3 && i[2] == CMD_HANDSHAKE_OK).unwrap_or(false));
    if !ok {
        anyhow::bail!("handshake failed");
    }
    // body = [target:8][type:1] — type 1 = call (ringtone), 0 = message.
    let mut wbody = target.to_vec();
    wbody.push(if is_call { 1 } else { 0 });
    let frame = build_server_bound(&me, &server_x_pub, &k_c2s, &pack_inner(1, CMD_WAKE, &wbody));
    ws.send(Message::Binary(frame)).await?;
    eprintln!("[wschat] WAKE sent for {}", hex::encode(target));
    // Give the relay a moment to forward before we drop the socket.
    tokio::time::sleep(Duration::from_millis(500)).await;
    let _ = ws.close(None).await;
    Ok(())
}

/// Build a peer TEXT frame with an explicit message id (so the outbox can
/// re-send the same id). Inner seq is irrelevant to the peer (it keys off
/// the 16-byte id in the body).
fn build_text_frame(me: &Identity, peer: &Peer, k_c2s: &[u8; 32], uuid: &[u8; 16], text: &str) -> Vec<u8> {
    let mut body = Vec::with_capacity(16 + text.len());
    body.extend_from_slice(uuid);
    body.extend_from_slice(text.as_bytes());
    build_peer_frame(me, &peer.x_pub, &peer.id, k_c2s, &pack_inner(0, CMD_TEXT, &body))
}

/// Build an INTRODUCE that always carries our nickname, so the peer records
/// us with a name (not "unnamed") whichever introduce reaches them first.
fn build_introduce(me: &Identity, peer: &Peer, nick: &str, k_c2s: &[u8; 32], server_x_pub: &[u8; 32], seq: u16) -> Vec<u8> {
    let mut body = Vec::with_capacity(8 + nick.len());
    body.extend_from_slice(&peer.id);
    body.extend_from_slice(nick.as_bytes());
    build_server_bound(me, server_x_pub, k_c2s, &pack_inner(seq, CMD_INTRODUCE, &body))
}

async fn send_text(
    text: &str,
    me: &Identity,
    peer: &Peer,
    nick: &str,
    k_c2s: &[u8; 32],
    server_x_pub: &[u8; 32],
    ws: &mut Ws,
    seq: &mut u16,
    sent: &mut HashMap<[u8; 16], OutMsg>,
) {
    // Re-introduce (with name) so an offline-then-online peer still gets our keys.
    let _ = ws.send(Message::Binary(build_introduce(me, peer, nick, k_c2s, server_x_pub, *seq))).await;
    *seq = seq.wrapping_add(1);

    let mut uuid = [0u8; 16];
    OsRng.fill_bytes(&mut uuid);
    // Record in the outbox BEFORE sending — if the peer is offline the send
    // still "succeeds" into the socket but no delivery-ack returns, so it
    // stays pending and gets re-sent on PEER_ONLINE.
    sent.insert(uuid, OutMsg { text: text.to_string(), delivered: false });
    let frame = build_text_frame(me, peer, k_c2s, &uuid, text);
    let _ = ws.send(Message::Binary(frame)).await;
}

/// Re-send every undelivered outbox message. Called on PEER_ONLINE and right
/// after (re)connect.
async fn flush_outbox(
    me: &Identity,
    peer: &Peer,
    nick: &str,
    k_c2s: &[u8; 32],
    server_x_pub: &[u8; 32],
    ws: &mut Ws,
    seq: &mut u16,
    sent: &mut HashMap<[u8; 16], OutMsg>,
) {
    let pending: Vec<([u8; 16], String)> = sent
        .iter()
        .filter(|(_, m)| !m.delivered)
        .map(|(id, m)| (*id, m.text.clone()))
        .collect();
    if pending.is_empty() {
        return;
    }
    eprintln!("[wschat] flushing {} pending message(s)", pending.len());
    let _ = ws.send(Message::Binary(build_introduce(me, peer, nick, k_c2s, server_x_pub, *seq))).await;
    *seq = seq.wrapping_add(1);
    for (uuid, text) in pending {
        let frame = build_text_frame(me, peer, k_c2s, &uuid, &text);
        let _ = ws.send(Message::Binary(frame)).await;
    }
}

async fn handle_incoming(
    frame: &[u8],
    me: &Identity,
    peer: &Peer,
    nick: &str,
    k_s2c: &[u8; 32],
    k_c2s: &[u8; 32],
    server_x_pub: &[u8; 32],
    server_ed_vk: &VerifyingKey,
    ws: &mut Ws,
    seq: &mut u16,
    sent: &mut HashMap<[u8; 16], OutMsg>,
) {
    use std::io::Write;
    if frame.len() < 8 + 24 + 16 + 64 {
        return;
    }
    let nonce_24: [u8; 24] = frame[8..32].try_into().unwrap();
    let mut header: [u8; 8] = frame[..8].try_into().unwrap();
    xor_header(k_s2c, &nonce_24, &mut header);

    if header == [0u8; 8] {
        // Server frame: we care about PEER_ONLINE to flush the outbox.
        if let Some(inner) = decode_server_frame(frame, k_s2c, &me.x_priv, server_x_pub, server_ed_vk) {
            if inner.len() >= 3 && inner[2] == CMD_PEER_ONLINE {
                eprintln!("[wschat] peer online — flushing outbox");
                flush_outbox(me, peer, nick, k_c2s, server_x_pub, ws, seq, sent).await;
            }
        }
        return;
    }

    // Peer frame. We only know one peer.
    let Some(inner) = verify_and_decrypt(&frame[8..], &me.x_priv, &peer.x_pub, &peer.ed_pub) else {
        return;
    };
    if inner.len() < 3 {
        return;
    }
    let cmd = inner[2];
    let body = &inner[3..];

    if cmd == CMD_TEXT && body.len() >= 16 {
        let text = String::from_utf8_lossy(&body[16..]).to_string();
        // Prefix EVERY line with the nick so multi-line messages aren't lost by
        // line-based log filters (a bare continuation line would otherwise be
        // dropped by `grep "<nick>:"`). One physical log line = one matchable line.
        for line in text.split('\n') {
            println!("{}: {}", peer.nick, line);
        }
        let _ = std::io::stdout().flush();
        // Acknowledge delivery, then read (we display incoming immediately).
        for ack_cmd in [CMD_DELIVERY_ACK, CMD_READ_ACK] {
            let ack = build_peer_frame(me, &peer.x_pub, &peer.id, k_c2s,
                &pack_inner(*seq, ack_cmd, &body[..16]));
            *seq = seq.wrapping_add(1);
            let _ = ws.send(Message::Binary(ack)).await;
        }
    } else if cmd == CMD_DELIVERY_ACK && body.len() >= 16 {
        let id: [u8; 16] = body[..16].try_into().unwrap();
        if let Some(m) = sent.get_mut(&id) { m.delivered = true; }
        let p = sent.get(&id).map(|m| m.text.clone()).unwrap_or_default();
        println!("  \u{2713} delivered: {p}");
        let _ = std::io::stdout().flush();
    } else if cmd == CMD_READ_ACK && body.len() >= 16 {
        let id: [u8; 16] = body[..16].try_into().unwrap();
        let p = sent.get(&id).map(|m| m.text.clone()).unwrap_or_default();
        println!("  \u{2713}\u{2713} read: {p}");
        let _ = std::io::stdout().flush();
    }
}

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
        return None;
    }
    verify_and_decrypt(&frame[8..], my_x_priv, server_x_pub, server_ed)
}

/// Read lines appended to `path` since byte `offset`; advance `offset`.
fn read_new_lines(path: &str, offset: &mut u64) -> Vec<String> {
    use std::io::{Read, Seek, SeekFrom};
    let mut out = Vec::new();
    let Ok(mut f) = std::fs::File::open(path) else { return out };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    if len < *offset {
        *offset = 0; // file truncated/rotated
    }
    if f.seek(SeekFrom::Start(*offset)).is_err() {
        return out;
    }
    let mut buf = String::new();
    if f.read_to_string(&mut buf).is_ok() {
        *offset += buf.len() as u64;
        for line in buf.lines() {
            out.push(line.to_string());
        }
    }
    out
}
