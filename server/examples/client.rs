//! Reference client for ws_server. Run two instances against a local
//! server to verify end-to-end routing.
//!
//! Usage:
//!   cargo run --example client -- <mode> [peer_x_pub_hex] [peer_ed_pub_hex]
//!
//! Modes:
//!   alice       connect, print own keys, then echo any received frame.
//!   bob         connect, print own keys, send "hello from bob" to peer.

use std::env;
use std::time::Duration;

use chacha20::ChaCha20;
use chacha20::cipher::{KeyIvInit, StreamCipher};
use chacha20poly1305::{Key, KeyInit, XChaCha20Poly1305, XNonce, aead::Aead};
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use futures_util::{SinkExt, StreamExt};
use rand::RngCore;
use rand::rngs::OsRng;
use tokio_tungstenite::tungstenite::Message;
use x25519_dalek::x25519;

const SERVER_X_PUB: [u8; 32] = [
    0x2b, 0xeb, 0xa3, 0x74, 0xae, 0xb4, 0x5b, 0x12, 0x20, 0xbd, 0x06, 0xa7, 0x94, 0xde, 0xa5, 0x4b,
    0xc4, 0x48, 0x4a, 0xad, 0x0a, 0x81, 0xdb, 0xea, 0x9d, 0x3d, 0x55, 0x18, 0xda, 0x73, 0x00, 0x5b,
];
const SERVER_ED_PUB: [u8; 32] = [
    0x08, 0xd9, 0x8c, 0x12, 0xe0, 0x44, 0xd5, 0xca, 0xcd, 0xf5, 0x49, 0x33, 0x93, 0x4c, 0x9a, 0x4e,
    0x34, 0xf4, 0xce, 0x7b, 0x35, 0x27, 0xad, 0xbd, 0x29, 0xa9, 0xc0, 0xa7, 0x36, 0xf3, 0xbf, 0x0f,
];
const PROTOCOL_VERSION: u8 = 2;

const CMD_HANDSHAKE_REQUEST: u8 = 0x01;
const CMD_HANDSHAKE_OK: u8 = 0x02;
const CMD_TEXT: u8 = 0x20;
const CMD_WAKE: u8 = 0x48;
const CMD_PUSH_REGISTER: u8 = 0x49;
const CMD_ERROR: u8 = 0xFF;

#[derive(Clone)]
struct Identity {
    x_priv: [u8; 32],
    x_pub: [u8; 32],
    ed: SigningKey,
    ed_pub: VerifyingKey,
    id: [u8; 8],
}

impl Identity {
    fn fresh() -> Self {
        let mut x_seed = [0u8; 32];
        let mut ed_seed_default = [0u8; 32];
        if let Ok(s) = env::var("CLIENT_X_SEED") {
            let v = hex::decode(s).expect("CLIENT_X_SEED hex");
            x_seed.copy_from_slice(&v);
        } else {
            OsRng.fill_bytes(&mut x_seed);
        }
        if let Ok(s) = env::var("CLIENT_ED_SEED") {
            let v = hex::decode(s).expect("CLIENT_ED_SEED hex");
            ed_seed_default.copy_from_slice(&v);
        } else {
            OsRng.fill_bytes(&mut ed_seed_default);
        }
        // X25519 clamping
        let mut x_priv = x_seed;
        x_priv[0] &= 248;
        x_priv[31] &= 127;
        x_priv[31] |= 64;
        let x_pub = x25519(x_priv, x25519_dalek::X25519_BASEPOINT_BYTES);

        let ed = SigningKey::from_bytes(&ed_seed_default);
        let ed_pub = ed.verifying_key();

        let mut id = [0u8; 8];
        id.copy_from_slice(&x_pub[..8]);

        Self {
            x_priv,
            x_pub,
            ed,
            ed_pub,
            id,
        }
    }
}

fn fresh_nonce_24() -> [u8; 24] {
    let mut n = [0u8; 24];
    OsRng.fill_bytes(&mut n);
    n
}

fn aead_encrypt(shared: &[u8; 32], nonce: &[u8; 24], plain: &[u8]) -> Vec<u8> {
    let cipher = XChaCha20Poly1305::new(Key::from_slice(shared));
    cipher
        .encrypt(XNonce::from_slice(nonce), plain)
        .expect("aead encrypt")
}

fn aead_decrypt(shared: &[u8; 32], nonce: &[u8; 24], ct: &[u8]) -> Option<Vec<u8>> {
    let cipher = XChaCha20Poly1305::new(Key::from_slice(shared));
    cipher.decrypt(XNonce::from_slice(nonce), ct).ok()
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
    if their_ed_pub
        .verify(nc, &Signature::from_bytes(sig))
        .is_err()
    {
        return None;
    }
    let nonce: &[u8; 24] = nc[..24].try_into().ok()?;
    let ct = &nc[24..];
    let shared = x25519(*my_x_priv, *their_x_pub);
    aead_decrypt(&shared, nonce, ct)
}

fn build_handshake_request(me: &Identity) -> Vec<u8> {
    let mut body = Vec::with_capacity(33);
    body.extend_from_slice(me.ed_pub.as_bytes());
    body.push(PROTOCOL_VERSION);
    let inner = pack_inner(0, CMD_HANDSHAKE_REQUEST, &body);
    let packet = encrypt_and_sign(&inner, &me.x_priv, &me.ed, &SERVER_X_PUB);

    let mut frame = Vec::with_capacity(32 + packet.len());
    frame.extend_from_slice(&me.x_pub);
    frame.extend_from_slice(&packet);
    frame
}

async fn run(mode: &str, peer_x_hex: Option<String>, peer_ed_hex: Option<String>) {
    let me = Identity::fresh();
    println!("== {} ==", mode);
    println!("my id     : {}", hex::encode(me.id));
    println!("my x_pub  : {}", hex::encode(me.x_pub));
    println!("my ed_pub : {}", hex::encode(me.ed_pub.as_bytes()));

    let url = std::env::var("WS_URL").unwrap_or_else(|_| "ws://127.0.0.1:8080/ws".to_string());
    println!("connecting to {}", url);
    let (mut ws, _) = tokio_tungstenite::connect_async(url).await.expect("connect");

    // Handshake.
    ws.send(Message::Binary(build_handshake_request(&me)))
        .await
        .unwrap();

    let server_ed_vk = VerifyingKey::from_bytes(&SERVER_ED_PUB).unwrap();
    let shared_with_server = x25519(me.x_priv, SERVER_X_PUB);
    let (k_c2s, k_s2c) = derive_session(&shared_with_server);

    // Read handshake reply.
    let reply = match ws.next().await {
        Some(Ok(Message::Binary(b))) => b,
        other => {
            panic!("unexpected handshake reply: {:?}", other);
        }
    };
    let inner = decode_server_frame(&reply, &k_s2c, &me.x_priv, &server_ed_vk)
        .expect("decode handshake reply");
    let cmd = inner[2];
    if cmd != CMD_HANDSHAKE_OK {
        panic!("handshake rejected, cmd=0x{:02x} body={:?}", cmd, &inner[3..]);
    }
    println!("handshake OK (server version 0x{:02x})", inner[3]);

    // Server-bound test commands for the notifier path.
    let send_server_bound = |ws_frame_cmd: u8, body: Vec<u8>| -> Vec<u8> {
        let inner = pack_inner(1, ws_frame_cmd, &body);
        let packet = encrypt_and_sign(&inner, &me.x_priv, &me.ed, &SERVER_X_PUB);
        let nonce_24: [u8; 24] = packet[..24].try_into().unwrap();
        let mut header = [0u8; 8];
        xor_header(&k_c2s, &nonce_24, &mut header);
        let mut frame = Vec::with_capacity(8 + packet.len());
        frame.extend_from_slice(&header);
        frame.extend_from_slice(&packet);
        frame
    };

    if mode == "register" {
        // register <token> — PUSH_REGISTER with kind=1 (FCM available).
        let token = peer_x_hex.clone().expect("usage: register <token>");
        let mut body = vec![1u8]; // kind = FCM
        body.extend_from_slice(token.as_bytes());
        ws.send(Message::Binary(send_server_bound(CMD_PUSH_REGISTER, body)))
            .await
            .unwrap();
        println!("→ PUSH_REGISTER id={} token={}", hex::encode(me.id), token);
        tokio::time::sleep(Duration::from_millis(300)).await;
        let _ = ws.close(None).await;
        return;
    }

    if mode == "wake" {
        // wake <target_id_hex>
        let target_hex = peer_x_hex.clone().expect("usage: wake <target_id_hex>");
        let target = hex::decode(target_hex).expect("target id hex");
        assert!(target.len() >= 8, "target id must be 8 bytes");
        ws.send(Message::Binary(send_server_bound(CMD_WAKE, target[..8].to_vec())))
            .await
            .unwrap();
        println!("→ WAKE target={}", hex::encode(&target[..8]));
        tokio::time::sleep(Duration::from_millis(300)).await;
        let _ = ws.close(None).await;
        return;
    }

    if mode == "bob" {
        let peer_x: [u8; 32] = hex::decode(peer_x_hex.expect("peer x_pub hex"))
            .unwrap()
            .try_into()
            .unwrap();
        let peer_ed: [u8; 32] = hex::decode(peer_ed_hex.expect("peer ed_pub hex"))
            .unwrap()
            .try_into()
            .unwrap();
        let mut peer_id = [0u8; 8];
        peer_id.copy_from_slice(&peer_x[..8]);
        let peer_ed_vk = VerifyingKey::from_bytes(&peer_ed).unwrap();

        // Wait a moment for alice to register.
        tokio::time::sleep(Duration::from_millis(300)).await;

        let inner = pack_inner(1, CMD_TEXT, b"hello from bob");
        let packet = encrypt_and_sign(&inner, &me.x_priv, &me.ed, &peer_x);
        let nonce_24: [u8; 24] = packet[..24].try_into().unwrap();
        let mut header = peer_id;
        xor_header(&k_c2s, &nonce_24, &mut header);
        let mut frame = Vec::with_capacity(8 + packet.len());
        frame.extend_from_slice(&header);
        frame.extend_from_slice(&packet);
        ws.send(Message::Binary(frame)).await.unwrap();
        println!("→ sent 'hello from bob' to {}", hex::encode(peer_id));

        // Wait for any reply, or for an error.
        if let Some(Ok(Message::Binary(b))) = ws.next().await {
            let nonce_24: [u8; 24] = b[8..32].try_into().unwrap();
            let mut header: [u8; 8] = b[..8].try_into().unwrap();
            xor_header(&k_s2c, &nonce_24, &mut header);
            if header == [0u8; 8] {
                let inner =
                    decode_server_frame(&b, &k_s2c, &me.x_priv, &server_ed_vk).unwrap();
                println!(
                    "← server message cmd=0x{:02x} body={:?}",
                    inner[2],
                    &inner[3..]
                );
            } else {
                let packet = &b[8..];
                let plain =
                    verify_and_decrypt(packet, &me.x_priv, &peer_x, &peer_ed_vk).unwrap();
                println!(
                    "← from {}: {}",
                    hex::encode(header),
                    String::from_utf8_lossy(&plain[3..])
                );
            }
        }
        let _ = ws.close(None).await;
        return;
    }

    // alice: echo loop.
    println!("alice waiting for messages…");
    let peer_x_hex_opt = peer_x_hex;
    let peer_ed_hex_opt = peer_ed_hex;
    while let Some(Ok(Message::Binary(b))) = ws.next().await {
        if b.len() < 8 + 24 + 16 + 64 {
            continue;
        }
        let nonce_24: [u8; 24] = b[8..32].try_into().unwrap();
        let mut header: [u8; 8] = b[..8].try_into().unwrap();
        xor_header(&k_s2c, &nonce_24, &mut header);
        if header == [0u8; 8] {
            let inner = decode_server_frame(&b, &k_s2c, &me.x_priv, &server_ed_vk).unwrap();
            println!(
                "← server cmd=0x{:02x} body={:?}",
                inner[2],
                hex::encode(&inner[3..])
            );
            continue;
        }
        // Peer message. Use given peer keys (we trust the launcher in this demo).
        let peer_x: [u8; 32] = match &peer_x_hex_opt {
            Some(h) => hex::decode(h).unwrap().try_into().unwrap(),
            None => {
                println!("← from {} (no peer keys configured)", hex::encode(header));
                continue;
            }
        };
        let peer_ed: [u8; 32] = hex::decode(peer_ed_hex_opt.as_ref().unwrap())
            .unwrap()
            .try_into()
            .unwrap();
        let peer_ed_vk = VerifyingKey::from_bytes(&peer_ed).unwrap();
        let packet = &b[8..];
        let plain = match verify_and_decrypt(packet, &me.x_priv, &peer_x, &peer_ed_vk) {
            Some(p) => p,
            None => {
                println!("× failed to verify/decrypt frame from {}", hex::encode(header));
                continue;
            }
        };
        let text = String::from_utf8_lossy(&plain[3..]).to_string();
        println!("← from {}: {}", hex::encode(header), text);

        // Echo back.
        let reply = pack_inner(2, CMD_TEXT, format!("echo: {}", text).as_bytes());
        let packet = encrypt_and_sign(&reply, &me.x_priv, &me.ed, &peer_x);
        let nonce_24: [u8; 24] = packet[..24].try_into().unwrap();
        let mut hdr = header;
        xor_header(&k_c2s, &nonce_24, &mut hdr);
        let mut frame = Vec::with_capacity(8 + packet.len());
        frame.extend_from_slice(&hdr);
        frame.extend_from_slice(&packet);
        ws.send(Message::Binary(frame)).await.unwrap();
        println!("→ echoed");
    }
}

fn decode_server_frame(
    frame: &[u8],
    k_s2c: &[u8; 32],
    my_x_priv: &[u8; 32],
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
    let packet = &frame[8..];
    verify_and_decrypt(packet, my_x_priv, &SERVER_X_PUB, server_ed)
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = env::args().collect();
    if args.len() < 2 {
        eprintln!("usage: client <alice|bob> [peer_x_pub_hex] [peer_ed_pub_hex]");
        std::process::exit(2);
    }
    let mode = args[1].clone();
    let peer_x = args.get(2).cloned();
    let peer_ed = args.get(3).cloned();
    run(&mode, peer_x, peer_ed).await;
}
