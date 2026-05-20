//! WebSocket request handler. Owns the per-connection state machine:
//!
//!   1. Read the first binary frame as a handshake (plaintext X_client_pub
//!      prefix + AEAD-signed inner blob).
//!   2. Reject collisions on client_id, send a handshake-OK frame, register
//!      the session.
//!   3. Loop on incoming frames: deobfuscate the 8-byte routing header,
//!      look up the recipient, forward or reply with a signed server-error
//!      frame.

use std::sync::Arc;
use std::time::Instant;

use actix_web::{Error, HttpRequest, HttpResponse, web};
use actix_ws::Message;
use ed25519_dalek::VerifyingKey;
use futures::future::{AbortHandle, Abortable};
use futures_util::StreamExt;
use tokio::sync::RwLock;

use crate::crypto25519::{
    CryptoError, derive_session_keys, encrypt_and_sign, verify_and_decrypt, x25519_shared,
    xor_header_8,
};
use crate::hub::{ClientId, ClientSession, HubState};
use crate::server_keys;

const PROTOCOL_VERSION: u8 = 2;

const CMD_HANDSHAKE_REQUEST: u8 = 0x01;
const CMD_HANDSHAKE_OK: u8 = 0x02;
const CMD_SUBSCRIBE: u8 = 0x40;
const CMD_UNSUBSCRIBE: u8 = 0x41;
const CMD_PEER_ONLINE: u8 = 0x42;
const CMD_PEER_OFFLINE: u8 = 0x43;
const CMD_INTRODUCE: u8 = 0x46;   // client → server: please tell <target> my keys
const CMD_INTRO_FROM: u8 = 0x47;  // server → client: here are <sender>'s keys
const CMD_WAKE: u8 = 0x48;        // client → server → notifier: wake <target>
const CMD_PUSH_REGISTER: u8 = 0x49; // client → server → notifier: my push token
const CMD_ERROR: u8 = 0xFF;

const ERR_ID_IN_USE: u8 = 1;
const ERR_BAD_VERSION: u8 = 2;
const ERR_RECIPIENT_OFFLINE: u8 = 3;

const MAX_FRAME_SIZE: usize = 1024 * 1024;
const ROUTING_MIN_LEN: usize = 8 + 24 + 16 + 64; // header + nonce + min AEAD + sig
const HANDSHAKE_MIN_LEN: usize = 32 + 24 + 16 + 64;

const ZERO_ID: ClientId = [0u8; 8];

/// ClientId = first 8 bytes of X25519 public key.
/// X25519 pub keys are uniformly random points on curve25519 — slicing the
/// first 8 bytes gives ~64 bits of pseudorandom id without a separate hash.
fn derive_client_id(x_pub: &[u8; 32]) -> ClientId {
    x_pub[..8].try_into().expect("32 >= 8")
}

/// Build an inner plaintext as `[message_id:u16 LE][cmd:u8][body]`.
fn pack_inner(message_id: u16, cmd: u8, body: &[u8]) -> Vec<u8> {
    let mut v = Vec::with_capacity(3 + body.len());
    v.extend_from_slice(&message_id.to_le_bytes());
    v.push(cmd);
    v.extend_from_slice(body);
    v
}

/// Encrypt+sign a server-originated message and prepend a XOR-obfuscated
/// zero header (which the client recognises as "this came from the server").
fn build_server_frame(
    recipient_x_pub: &[u8; 32],
    recipient_k_s2c: &[u8; 32],
    inner: &[u8],
) -> Result<Vec<u8>, CryptoError> {
    let packet = encrypt_and_sign(
        inner,
        &server_keys::X25519_SECRET,
        &server_keys::ed25519_signing(),
        recipient_x_pub,
    )?;
    // packet = [nonce:24][ciphertext][sig:64]
    let nonce_24: &[u8; 24] = packet[..24]
        .try_into()
        .map_err(|_| CryptoError::BadFormat)?;
    let mut header = ZERO_ID;
    xor_header_8(recipient_k_s2c, nonce_24, &mut header);

    let mut out = Vec::with_capacity(8 + packet.len());
    out.extend_from_slice(&header);
    out.extend_from_slice(&packet);
    Ok(out)
}

pub async fn handler(
    req: HttpRequest,
    payload: web::Payload,
    hub: web::Data<Arc<RwLock<HubState>>>,
) -> Result<HttpResponse, Error> {
    let (response, session, msg_stream) = actix_ws::handle(&req, payload)?;
    let msg_stream = msg_stream.max_frame_size(MAX_FRAME_SIZE);

    let ip = req
        .peer_addr()
        .map(|a| a.ip().to_string())
        .unwrap_or_default();
    let hub = hub.get_ref().clone();

    let (abort_handle, abort_reg) = AbortHandle::new_pair();
    actix_web::rt::spawn(Abortable::new(
        connection_task(session, msg_stream, hub, ip, abort_handle),
        abort_reg,
    ));

    Ok(response)
}

async fn connection_task(
    mut session: actix_ws::Session,
    mut stream: actix_ws::MessageStream,
    hub: Arc<RwLock<HubState>>,
    ip: String,
    abort: AbortHandle,
) {
    let (client_id, x_pub, k_c2s, _k_s2c) =
        match perform_handshake(&mut session, &mut stream, &hub, &ip, abort.clone()).await {
            Some(v) => v,
            None => return,
        };

    tracing::debug!(
        "client {} established from {}",
        hex::encode(client_id),
        ip
    );
    // Tell anyone watching this X_pub that the peer is now online.
    broadcast_presence(&hub, &x_pub, true).await;

    while let Some(Ok(msg)) = stream.next().await {
        match msg {
            Message::Ping(b) => {
                {
                    let mut h = hub.write().await;
                    h.touch(&client_id);
                }
                let _ = session.pong(&b).await;
            }
            Message::Pong(_) => {
                let mut h = hub.write().await;
                h.touch(&client_id);
            }
            Message::Close(reason) => {
                let _ = session.close(reason).await;
                break;
            }
            Message::Binary(bytes) => {
                {
                    let mut h = hub.write().await;
                    h.touch(&client_id);
                }
                if let Err(e) = handle_routing_frame(
                    &client_id,
                    &k_c2s,
                    &bytes,
                    &hub,
                    &mut session,
                )
                .await
                {
                    tracing::warn!(
                        "routing error from {}: {:?}",
                        hex::encode(client_id),
                        e
                    );
                }
            }
            other => {
                tracing::debug!("ignoring frame: {:?}", other);
            }
        }
    }

    {
        let mut h = hub.write().await;
        h.remove(&client_id);
        h.remove_all_subscriptions(&client_id);
    }
    broadcast_presence(&hub, &x_pub, false).await;
    tracing::debug!("client {} disconnected", hex::encode(client_id));
}

#[derive(Debug)]
enum RouteError {
    TooShort,
    SelfAddressed,
    Crypto(CryptoError),
}

impl From<CryptoError> for RouteError {
    fn from(e: CryptoError) -> Self {
        RouteError::Crypto(e)
    }
}

async fn handle_routing_frame(
    sender_id: &ClientId,
    sender_k_c2s: &[u8; 32],
    bytes: &[u8],
    hub: &Arc<RwLock<HubState>>,
    session: &mut actix_ws::Session,
) -> Result<(), RouteError> {
    if bytes.len() < ROUTING_MIN_LEN {
        return Err(RouteError::TooShort);
    }
    let nonce_24: [u8; 24] = bytes[8..32]
        .try_into()
        .map_err(|_| RouteError::TooShort)?;

    let mut header: ClientId = bytes[..8]
        .try_into()
        .map_err(|_| RouteError::TooShort)?;
    xor_header_8(sender_k_c2s, &nonce_24, &mut header);
    let to_id = header;

    if to_id == ZERO_ID {
        // Server-bound frame: subscribe / unsubscribe.
        return handle_server_bound(sender_id, &bytes[8..], hub, session).await;
    }

    // Look up recipient and grab the data we need under the lock.
    let recipient = {
        let h = hub.read().await;
        h.get(&to_id).map(|s| (s.ws.clone(), s.k_s2c))
    };

    match recipient {
        Some((mut recipient_ws, k_s2c_recipient)) => {
            let mut out = Vec::with_capacity(bytes.len());
            let mut delivery_header: ClientId = *sender_id;
            xor_header_8(&k_s2c_recipient, &nonce_24, &mut delivery_header);
            out.extend_from_slice(&delivery_header);
            out.extend_from_slice(&bytes[8..]);
            if recipient_ws.binary(out).await.is_err() {
                tracing::warn!(
                    "recipient {} send failed — treating as offline",
                    hex::encode(to_id)
                );
                send_offline_error(session, sender_id, hub, &to_id, &nonce_24).await?;
            }
        }
        None => {
            send_offline_error(session, sender_id, hub, &to_id, &nonce_24).await?;
        }
    }
    Ok(())
}

/// Decrypt a server-bound AEAD packet (everything after the 8-byte routing
/// header) and dispatch by cmd. SUBSCRIBE / UNSUBSCRIBE are the only
/// supported server-directed commands in v2.
async fn handle_server_bound(
    sender_id: &ClientId,
    packet: &[u8],
    hub: &Arc<RwLock<HubState>>,
    session: &mut actix_ws::Session,
) -> Result<(), RouteError> {
    let (sender_x_pub, sender_ed_pub, sender_k_s2c) = {
        let h = hub.read().await;
        match h.get(sender_id) {
            Some(s) => (s.x_pub, s.ed_pub, s.k_s2c),
            None => return Ok(()),
        }
    };

    let plaintext = verify_and_decrypt(
        packet,
        &server_keys::X25519_SECRET,
        &sender_x_pub,
        &sender_ed_pub,
    )
    .map_err(RouteError::Crypto)?;

    if plaintext.len() < 3 {
        return Err(RouteError::TooShort);
    }
    let cmd = plaintext[2];
    let body = &plaintext[3..];

    match cmd {
        CMD_SUBSCRIBE => apply_subscribe(sender_id, &sender_x_pub, &sender_k_s2c, body, hub, session).await,
        CMD_UNSUBSCRIBE => apply_unsubscribe(sender_id, body, hub).await,
        CMD_INTRODUCE => apply_introduce(sender_id, body, hub).await,
        CMD_WAKE => apply_wake(body, hub).await,
        CMD_PUSH_REGISTER => apply_push_register(sender_id, body, hub).await,
        _ => {
            tracing::warn!(
                "unknown server-bound cmd 0x{:02x} from {}",
                cmd,
                hex::encode(sender_id)
            );
            Ok(())
        }
    }
}

fn parse_x_list(body: &[u8]) -> Option<Vec<[u8; 32]>> {
    if body.len() % 32 != 0 {
        return None;
    }
    Some(body.chunks_exact(32).map(|c| c.try_into().unwrap()).collect())
}

async fn apply_subscribe(
    sender_id: &ClientId,
    sender_x_pub: &[u8; 32],
    sender_k_s2c: &[u8; 32],
    body: &[u8],
    hub: &Arc<RwLock<HubState>>,
    session: &mut actix_ws::Session,
) -> Result<(), RouteError> {
    let Some(xs) = parse_x_list(body) else {
        tracing::warn!("subscribe body not aligned to 32 bytes");
        return Err(RouteError::TooShort);
    };

    let mut already_online: Vec<u8> = Vec::new();
    {
        let mut h = hub.write().await;
        for x in &xs {
            if h.add_subscription(*sender_id, *x) {
                already_online.extend_from_slice(x);
            }
        }
    }

    if !already_online.is_empty() {
        let inner = pack_inner(0, CMD_PEER_ONLINE, &already_online);
        let frame = build_server_frame(sender_x_pub, sender_k_s2c, &inner)
            .map_err(RouteError::Crypto)?;
        let _ = session.binary(frame).await;
    }
    Ok(())
}

/// INTRODUCE: client asks the server to forward its public keys (plus an
/// optional nickname) to a target peer. Body layout:
///     [target_id : 8][nickname_utf8 : variable]
/// The server pulls the *sender's* x_pub and ed_pub out of its own
/// ClientSession (so the introduction is impossible to forge from the
/// client side), appends them to nickname, and pushes an INTRO_FROM
/// server-frame to the target.
async fn apply_introduce(
    sender_id: &ClientId,
    body: &[u8],
    hub: &Arc<RwLock<HubState>>,
) -> Result<(), RouteError> {
    if body.len() < 8 {
        tracing::warn!("introduce body too short");
        return Err(RouteError::TooShort);
    }
    let target_id: ClientId = body[..8].try_into().unwrap();
    let nickname = &body[8..];

    let (sender_x_pub, sender_ed_pub) = {
        let h = hub.read().await;
        match h.get(sender_id) {
            Some(s) => (s.x_pub, s.ed_pub.to_bytes()),
            None => return Ok(()),
        }
    };

    let target = {
        let h = hub.read().await;
        h.get(&target_id).map(|s| (s.x_pub, s.k_s2c, s.ws.clone()))
    };
    let Some((target_x_pub, target_k_s2c, mut target_ws)) = target else {
        tracing::debug!(
            "introduce: target {} not online",
            hex::encode(target_id)
        );
        return Ok(()); // silently drop — caller may retry later
    };

    let mut out_body = Vec::with_capacity(32 + 32 + nickname.len());
    out_body.extend_from_slice(&sender_x_pub);
    out_body.extend_from_slice(&sender_ed_pub);
    out_body.extend_from_slice(nickname);

    let inner = pack_inner(0, CMD_INTRO_FROM, &out_body);
    let frame = build_server_frame(&target_x_pub, &target_k_s2c, &inner)
        .map_err(RouteError::Crypto)?;
    let _ = target_ws.binary(frame).await;
    Ok(())
}

/// Forward an opaque payload to the push-notifier peer as a server-frame.
/// The server holds no push state — it only relays to NOTIFIER_ID, exactly
/// like INTRODUCE relays to a target. If the notifier is offline, drop.
async fn forward_to_notifier(
    cmd: u8,
    body: &[u8],
    hub: &Arc<RwLock<HubState>>,
) -> Result<(), RouteError> {
    let notifier = {
        let h = hub.read().await;
        h.get(&server_keys::NOTIFIER_ID)
            .map(|s| (s.x_pub, s.k_s2c, s.ws.clone()))
    };
    let Some((nx, nk, mut nws)) = notifier else {
        tracing::debug!("notifier offline — dropping cmd 0x{:02x}", cmd);
        return Ok(());
    };
    let inner = pack_inner(0, cmd, body);
    let frame = build_server_frame(&nx, &nk, &inner).map_err(RouteError::Crypto)?;
    let _ = nws.binary(frame).await;
    Ok(())
}

/// WAKE: client asks to wake an offline peer. Body = [target_id:8].
/// Forwarded verbatim to the notifier, which looks up the push token.
async fn apply_wake(body: &[u8], hub: &Arc<RwLock<HubState>>) -> Result<(), RouteError> {
    if body.len() < 8 {
        tracing::warn!("wake body too short");
        return Err(RouteError::TooShort);
    }
    forward_to_notifier(CMD_WAKE, &body[..8], hub).await
}

/// PUSH_REGISTER: client registers its push token. Body = [kind:1][token].
/// The server prepends the sender's id (taken from the verified session, so
/// it can't be forged) before forwarding to the notifier.
async fn apply_push_register(
    sender_id: &ClientId,
    body: &[u8],
    hub: &Arc<RwLock<HubState>>,
) -> Result<(), RouteError> {
    if body.is_empty() {
        tracing::warn!("push_register body too short");
        return Err(RouteError::TooShort);
    }
    let mut out = Vec::with_capacity(8 + body.len());
    out.extend_from_slice(sender_id);
    out.extend_from_slice(body); // [kind:1][token]
    forward_to_notifier(CMD_PUSH_REGISTER, &out, hub).await
}

async fn apply_unsubscribe(
    sender_id: &ClientId,
    body: &[u8],
    hub: &Arc<RwLock<HubState>>,
) -> Result<(), RouteError> {
    let Some(xs) = parse_x_list(body) else {
        tracing::warn!("unsubscribe body not aligned to 32 bytes");
        return Err(RouteError::TooShort);
    };
    let mut h = hub.write().await;
    for x in &xs {
        h.remove_subscription(sender_id, x);
    }
    Ok(())
}

/// Broadcast a single peer's presence change to all of their subscribers.
async fn broadcast_presence(hub: &Arc<RwLock<HubState>>, x_pub: &[u8; 32], online: bool) {
    let targets = {
        let h = hub.read().await;
        h.subscribers_targets(x_pub)
    };
    let cmd = if online { CMD_PEER_ONLINE } else { CMD_PEER_OFFLINE };
    for (sub_x, sub_k_s2c, mut sub_ws) in targets {
        let inner = pack_inner(0, cmd, x_pub);
        let frame = match build_server_frame(&sub_x, &sub_k_s2c, &inner) {
            Ok(f) => f,
            Err(e) => {
                tracing::warn!("broadcast frame build failed: {:?}", e);
                continue;
            }
        };
        let _ = sub_ws.binary(frame).await;
    }
}

async fn send_offline_error(
    session: &mut actix_ws::Session,
    sender_id: &ClientId,
    hub: &Arc<RwLock<HubState>>,
    target_id: &ClientId,
    orig_nonce: &[u8; 24],
) -> Result<(), CryptoError> {
    let (sender_x_pub, sender_k_s2c) = {
        let h = hub.read().await;
        match h.get(sender_id) {
            Some(s) => (s.x_pub, s.k_s2c),
            None => return Ok(()), // sender gone, nothing to do
        }
    };

    let mut body = Vec::with_capacity(1 + 8 + 24);
    body.push(ERR_RECIPIENT_OFFLINE);
    body.extend_from_slice(target_id);
    body.extend_from_slice(orig_nonce);

    let inner = pack_inner(0, CMD_ERROR, &body);
    let frame = build_server_frame(&sender_x_pub, &sender_k_s2c, &inner)?;
    let _ = session.binary(frame).await;
    Ok(())
}

/// Read and validate the first frame of the connection. On success,
/// inserts the new session into the hub and returns the IDs/keys needed
/// for the routing loop. On failure, sends a plaintext close and returns
/// None.
async fn perform_handshake(
    session: &mut actix_ws::Session,
    stream: &mut actix_ws::MessageStream,
    hub: &Arc<RwLock<HubState>>,
    ip: &str,
    abort: AbortHandle,
) -> Option<(ClientId, [u8; 32], [u8; 32], [u8; 32])> {
    let first = match stream.next().await {
        Some(Ok(Message::Binary(b))) => b,
        Some(Ok(other)) => {
            tracing::warn!("handshake: expected binary, got {:?}", other);
            let _ = session.clone().close(None).await;
            return None;
        }
        _ => {
            let _ = session.clone().close(None).await;
            return None;
        }
    };

    if first.len() < HANDSHAKE_MIN_LEN {
        tracing::warn!("handshake too short: {} bytes", first.len());
        let _ = session.clone().close(None).await;
        return None;
    }

    let client_x_pub: [u8; 32] = first[..32].try_into().unwrap();
    let aead_packet = &first[32..];

    // Manual AEAD decrypt (we don't yet know the client's Ed25519 key — it
    // arrives inside the ciphertext). After we extract it, verify the
    // signature over (nonce || ciphertext).
    let (nonce_24, ciphertext, sig_bytes) = match split_aead_packet(aead_packet) {
        Some(t) => t,
        None => {
            tracing::warn!("handshake AEAD packet malformed");
            let _ = session.clone().close(None).await;
            return None;
        }
    };

    let shared = x25519_shared(&server_keys::X25519_SECRET, &client_x_pub);
    let plaintext = match aead_decrypt(&shared, nonce_24, ciphertext) {
        Ok(p) => p,
        Err(_) => {
            tracing::warn!("handshake AEAD decrypt failed (bad client key?)");
            let _ = session.clone().close(None).await;
            return None;
        }
    };

    // Plaintext layout: [msg_id:u16 LE][cmd:u8][ed_pub:32][version:u8]
    if plaintext.len() < 2 + 1 + 32 + 1 {
        tracing::warn!("handshake plaintext too short");
        let _ = session.clone().close(None).await;
        return None;
    }
    let cmd = plaintext[2];
    if cmd != CMD_HANDSHAKE_REQUEST {
        tracing::warn!("handshake cmd unexpected: 0x{:02x}", cmd);
        let _ = session.clone().close(None).await;
        return None;
    }
    let client_ed_bytes: [u8; 32] = plaintext[3..35].try_into().unwrap();
    let client_version = plaintext[35];
    let client_ed_pub = match VerifyingKey::from_bytes(&client_ed_bytes) {
        Ok(k) => k,
        Err(_) => {
            tracing::warn!("handshake: invalid ed25519 public key");
            let _ = session.clone().close(None).await;
            return None;
        }
    };

    // Now verify the Ed25519 signature with the freshly-learned key.
    let mut signed_region: Vec<u8> = Vec::with_capacity(24 + ciphertext.len());
    signed_region.extend_from_slice(nonce_24);
    signed_region.extend_from_slice(ciphertext);
    if !verify_signature(&signed_region, sig_bytes, &client_ed_pub) {
        tracing::warn!("handshake: bad client signature");
        let _ = session.clone().close(None).await;
        return None;
    }

    // Derive routing keys and figure out the client's id.
    let (k_c2s, k_s2c) = derive_session_keys(&shared);
    let client_id = derive_client_id(&client_x_pub);

    // Version check first.
    let reply_inner = if client_version != PROTOCOL_VERSION {
        pack_inner(0, CMD_ERROR, &[ERR_BAD_VERSION, PROTOCOL_VERSION])
    } else {
        let collision = {
            let h = hub.read().await;
            h.contains(&client_id)
        };
        if collision {
            // Old session wins. The new connection must back off; the
            // client is expected to stop auto-reconnect on this code.
            pack_inner(0, CMD_ERROR, &[ERR_ID_IN_USE])
        } else {
            pack_inner(0, CMD_HANDSHAKE_OK, &[PROTOCOL_VERSION])
        }
    };

    // Build and send the reply (server-originated frame: zero header + AEAD).
    let frame = match build_server_frame(&client_x_pub, &k_s2c, &reply_inner) {
        Ok(f) => f,
        Err(e) => {
            tracing::error!("failed to build handshake reply: {:?}", e);
            let _ = session.clone().close(None).await;
            return None;
        }
    };
    if session.binary(frame).await.is_err() {
        let _ = session.clone().close(None).await;
        return None;
    }

    // If we sent an error, close and bail.
    if reply_inner[2] == CMD_ERROR {
        let _ = session.clone().close(None).await;
        return None;
    }

    // Register the session in the hub.
    let now = Instant::now();
    let new_session = ClientSession {
        ws: session.clone(),
        abort,
        ip: ip.to_string(),
        x_pub: client_x_pub,
        ed_pub: client_ed_pub,
        k_c2s,
        k_s2c,
        last_seen: now,
        last_ping: now,
    };
    {
        let mut h = hub.write().await;
        h.insert(client_id, new_session);
    }
    Some((client_id, client_x_pub, k_c2s, k_s2c))
}

fn split_aead_packet(packet: &[u8]) -> Option<(&[u8; 24], &[u8], &[u8; 64])> {
    if packet.len() < 24 + 16 + 64 {
        return None;
    }
    let nonce: &[u8; 24] = packet[..24].try_into().ok()?;
    let (rest, sig) = packet[24..].split_at(packet.len() - 24 - 64);
    let sig_arr: &[u8; 64] = sig.try_into().ok()?;
    Some((nonce, rest, sig_arr))
}

fn aead_decrypt(
    shared: &[u8; 32],
    nonce_24: &[u8; 24],
    ciphertext: &[u8],
) -> Result<Vec<u8>, CryptoError> {
    use chacha20poly1305::{Key, KeyInit, XChaCha20Poly1305, XNonce, aead::Aead};
    let cipher = XChaCha20Poly1305::new(Key::from_slice(shared));
    cipher
        .decrypt(XNonce::from_slice(nonce_24), ciphertext)
        .map_err(|_| CryptoError::BadCiphertext)
}

fn verify_signature(data: &[u8], sig: &[u8; 64], pk: &VerifyingKey) -> bool {
    use ed25519_dalek::{Signature, Verifier};
    pk.verify(data, &Signature::from_bytes(sig)).is_ok()
}

