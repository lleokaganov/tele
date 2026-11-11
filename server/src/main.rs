//! ws_server — minimal WebSocket relay for end-to-end encrypted traffic
//! between paired clients. See doc/PROTOCOL.md for the wire format.
//!
//! The server holds:
//!   * a long-term X25519 keypair (for handshake AEAD and server-originated
//!     error messages, encrypted to the client's X25519 key);
//!   * a long-term Ed25519 keypair (for signing server-originated frames so
//!     clients can use the same verify-then-decrypt path on every frame).
//!
//! Both keypairs are constants in `server_keys.rs`. Clients embed the
//! public halves.

mod crypto25519;
mod handlers_ws;
mod hub;
mod server_keys;

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use actix_web::{App, HttpResponse, HttpServer, web};
use tokio::sync::RwLock;
use tracing_subscriber::{EnvFilter, fmt};

use hub::{HubState, spawn_heartbeat};

const DEFAULT_BIND: &str = "0.0.0.0:80";
const HEARTBEAT_TIMEOUT: Duration = Duration::from_secs(60);
const PING_INTERVAL: Duration = Duration::from_secs(20);

fn init_tracing() {
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("ws_server=info,actix=warn"));
    fmt().with_env_filter(filter).compact().init();
}

#[actix_web::main]
async fn main() -> anyhow::Result<()> {
    init_tracing();
    tracing::info!(
        "{} v{} starting",
        env!("CARGO_PKG_NAME"),
        env!("CARGO_PKG_VERSION")
    );
    tracing::info!(
        "server X25519 public: {}",
        hex::encode(server_keys::X25519_PUBLIC)
    );
    tracing::info!(
        "server Ed25519 public: {}",
        hex::encode(server_keys::ED25519_PUBLIC)
    );

    let bind: SocketAddr = std::env::var("WS_BIND")
        .unwrap_or_else(|_| DEFAULT_BIND.to_string())
        .parse()?;

    let hub = Arc::new(RwLock::new(HubState::new()));
    spawn_heartbeat(hub.clone(), HEARTBEAT_TIMEOUT, PING_INTERVAL);

    tracing::info!("listening on ws://{}/ws", bind);

    HttpServer::new(move || {
        App::new()
            .app_data(web::Data::new(hub.clone()))
            .route("/ws", web::get().to(handlers_ws::handler))
            .route(
                "/status",
                web::get().to({
                    move |hub: web::Data<Arc<RwLock<HubState>>>| {
                        let hub = hub.clone();
                        async move {
                            let info = {
                                let h = hub.read().await;
                                h.info_json()
                            };
                            Ok::<_, actix_web::Error>(HttpResponse::Ok().json(info))
                        }
                    }
                }),
            )
    })
    .bind(bind)?
    .run()
    .await?;

    Ok(())
}
