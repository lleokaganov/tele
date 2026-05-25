//! In-memory connection registry. Holds, for every connected client, just
//! enough state to route opaque frames and answer the (handful of) server
//! messages. No persistence, no auth, no users table.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use ed25519_dalek::VerifyingKey;
use futures::future::AbortHandle;
use serde_json::{Value, json};
use tokio::sync::RwLock;

/// 8-byte client identifier — first 8 bytes of SHA-256(X_client_pub).
pub type ClientId = [u8; 8];

pub struct ClientSession {
    pub ws: actix_ws::Session,
    pub abort: AbortHandle,
    pub ip: String,

    /// Client's X25519 public key — used to encrypt server messages to them.
    pub x_pub: [u8; 32],
    /// Client's Ed25519 public key — currently unused by the server, kept
    /// so a future version can verify client signatures without changing
    /// the handshake.
    pub ed_pub: VerifyingKey,

    /// Routing-header obfuscation keys, derived once at handshake from
    /// HKDF(shared(X_client, X_server)).
    pub k_c2s: [u8; 32],
    pub k_s2c: [u8; 32],

    pub last_seen: std::time::Instant,
    pub last_ping: std::time::Instant,
}

#[derive(Default)]
pub struct HubState {
    by_id: HashMap<ClientId, ClientSession>,
    /// Set of every X25519 pub currently online — for O(1) "is X online?"
    /// without scanning by_id.
    online_xs: HashSet<[u8; 32]>,
    /// Reverse index for broadcast: target X → set of subscriber ClientIds.
    subscribers_of: HashMap<[u8; 32], HashSet<ClientId>>,
    /// Forward index for cleanup-on-disconnect: my ClientId → set of X
    /// keys I'm watching.
    my_subs: HashMap<ClientId, HashSet<[u8; 32]>>,
    started_at: Option<std::time::SystemTime>,
}

impl HubState {
    pub fn new() -> Self {
        Self {
            by_id: HashMap::new(),
            online_xs: HashSet::new(),
            subscribers_of: HashMap::new(),
            my_subs: HashMap::new(),
            started_at: Some(std::time::SystemTime::now()),
        }
    }

    pub fn contains(&self, id: &ClientId) -> bool {
        self.by_id.contains_key(id)
    }

    pub fn is_x_online(&self, x: &[u8; 32]) -> bool {
        self.online_xs.contains(x)
    }

    pub fn insert(&mut self, id: ClientId, session: ClientSession) {
        self.online_xs.insert(session.x_pub);
        self.by_id.insert(id, session);
    }

    pub fn remove(&mut self, id: &ClientId) -> Option<ClientSession> {
        let s = self.by_id.remove(id)?;
        self.online_xs.remove(&s.x_pub);
        Some(s)
    }

    pub fn get(&self, id: &ClientId) -> Option<&ClientSession> {
        self.by_id.get(id)
    }

    pub fn get_mut(&mut self, id: &ClientId) -> Option<&mut ClientSession> {
        self.by_id.get_mut(id)
    }

    pub fn len(&self) -> usize {
        self.by_id.len()
    }

    /// Register that `me` is watching `target_x`. Returns true iff the
    /// target is currently online, so the caller can push a synthetic
    /// PEER_ONLINE back to the subscriber.
    pub fn add_subscription(&mut self, me: ClientId, target_x: [u8; 32]) -> bool {
        self.subscribers_of
            .entry(target_x)
            .or_default()
            .insert(me);
        self.my_subs.entry(me).or_default().insert(target_x);
        self.online_xs.contains(&target_x)
    }

    pub fn remove_subscription(&mut self, me: &ClientId, target_x: &[u8; 32]) {
        if let Some(set) = self.subscribers_of.get_mut(target_x) {
            set.remove(me);
            if set.is_empty() {
                self.subscribers_of.remove(target_x);
            }
        }
        if let Some(set) = self.my_subs.get_mut(me) {
            set.remove(target_x);
            if set.is_empty() {
                self.my_subs.remove(me);
            }
        }
    }

    /// Tear down every subscription created by `me`, both directions.
    /// Called on disconnect.
    pub fn remove_all_subscriptions(&mut self, me: &ClientId) {
        if let Some(xs) = self.my_subs.remove(me) {
            for x in xs {
                if let Some(set) = self.subscribers_of.get_mut(&x) {
                    set.remove(me);
                    if set.is_empty() {
                        self.subscribers_of.remove(&x);
                    }
                }
            }
        }
    }

    /// Returns broadcast targets for subscribers watching `target_x`:
    /// (their X_pub, their K_s2c, their ws session) — everything needed
    /// to send a server frame.
    pub fn subscribers_targets(
        &self,
        target_x: &[u8; 32],
    ) -> Vec<([u8; 32], [u8; 32], actix_ws::Session)> {
        let Some(subs) = self.subscribers_of.get(target_x) else {
            return Vec::new();
        };
        subs.iter()
            .filter_map(|sid| self.by_id.get(sid))
            .map(|s| (s.x_pub, s.k_s2c, s.ws.clone()))
            .collect()
    }

    pub fn touch(&mut self, id: &ClientId) {
        if let Some(s) = self.by_id.get_mut(id) {
            let now = std::time::Instant::now();
            s.last_seen = now;
            s.last_ping = now;
        }
    }

    pub fn info_json(&self) -> Value {
        let started = self
            .started_at
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let uptime_sec = self
            .started_at
            .and_then(|t| t.elapsed().ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        json!({
            "started_at": started,
            "uptime_sec": uptime_sec,
            "connections": self.by_id.len(),
            "version": env!("CARGO_PKG_VERSION"),
            "status": "OK",
        })
    }
}

/// Background task that pings each connection and drops the ones that
/// haven't said anything for a while.
pub fn spawn_heartbeat(
    hub: Arc<RwLock<HubState>>,
    heartbeat_timeout: std::time::Duration,
    ping_interval: std::time::Duration,
) {
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(std::time::Duration::from_secs(2));
        loop {
            ticker.tick().await;
            let now = std::time::Instant::now();

            // Snapshot under the read lock; everything that needs an `.await`
            // (WS pings + the plain-text keepalive) happens AFTER the lock is
            // dropped — never hold the lock across an await.
            let (to_drop, to_ping) = {
                let hub_r = hub.read().await;
                let mut drop_list: Vec<ClientId> = Vec::new();
                let mut ping_list: Vec<(ClientId, actix_ws::Session)> = Vec::new();
                for (id, s) in hub_r.by_id.iter() {
                    if now.duration_since(s.last_seen) > heartbeat_timeout {
                        drop_list.push(*id);
                    } else if now.duration_since(s.last_ping) > ping_interval {
                        ping_list.push((*id, s.ws.clone()));
                    }
                }
                (drop_list, ping_list)
            };

            for (_, mut session) in to_ping.iter().cloned() {
                // 1) WS-protocol ping: server-side liveness (drives the
                //    last_seen/drop logic). Invisible to the client's JS.
                let _ = session.ping(&[]).await;
                // 2) VISIBLE plain-text keepalive OUTSIDE the encrypted
                //    protocol: a bare "ping" text frame that lands in the
                //    client's onmessage handler so JS can observe the socket is
                //    still alive (bumps lastRx); the client replies "pong".
                let _ = session.text("ping").await;
            }

            if !to_drop.is_empty() || !to_ping.is_empty() {
                let mut hub_w = hub.write().await;
                for id in &to_drop {
                    if let Some(s) = hub_w.remove(id) {
                        s.abort.abort();
                        let _ = s.ws.close(None).await;
                        tracing::debug!(
                            "heartbeat drop {} (remaining {})",
                            hex::encode(id),
                            hub_w.len()
                        );
                    }
                }
                for (id, _) in &to_ping {
                    if let Some(s) = hub_w.get_mut(id) {
                        s.last_ping = now;
                    }
                }
            }
        }
    });
}
