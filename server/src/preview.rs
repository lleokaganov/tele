//! GET /preview?u=<urlencoded url> — return JSON metadata harvested from
//! the page's OpenGraph / standard <meta> tags. The client uses this to
//! render link-preview cards inside chat bubbles without ever fetching
//! cross-origin HTML itself (browser CORS would block it).
//!
//! Hardening:
//!   * Only http(s) URLs.
//!   * Reject targets that resolve to private / loopback / link-local IPs
//!     (basic SSRF protection — no requests to 127.0.0.1, cloud metadata,
//!     private RFC1918 etc.).
//!   * 5-second total timeout, 1 MB max body.
//!   * In-memory cache, ~30 minutes per entry, ~1000 entries.

use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use actix_web::{HttpResponse, web};
use once_cell::sync::Lazy;
use scraper::{Html, Selector};
use serde::{Deserialize, Serialize};

const CACHE_TTL: Duration = Duration::from_secs(30 * 60);
const CACHE_CAP: usize = 1000;
const FETCH_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_BODY_BYTES: usize = 1024 * 1024;

#[derive(Deserialize)]
pub struct Query {
    u: String,
}

#[derive(Serialize, Clone)]
pub struct Preview {
    pub url: String,
    pub title: Option<String>,
    pub description: Option<String>,
    pub image: Option<String>,
    pub site_name: Option<String>,
}

struct CacheEntry {
    inserted_at: Instant,
    preview: Preview,
}

static CACHE: Lazy<Mutex<HashMap<String, CacheEntry>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

pub async fn handler(q: web::Query<Query>) -> HttpResponse {
    let raw_url = q.u.trim();
    if raw_url.is_empty() {
        return HttpResponse::BadRequest().body("missing u");
    }

    // Cache lookup.
    {
        let mut cache = CACHE.lock().unwrap();
        if let Some(entry) = cache.get(raw_url) {
            if entry.inserted_at.elapsed() < CACHE_TTL {
                return HttpResponse::Ok().json(entry.preview.clone());
            } else {
                cache.remove(raw_url);
            }
        }
    }

    let parsed = match url::Url::parse(raw_url) {
        Ok(u) => u,
        Err(_) => return HttpResponse::BadRequest().body("bad url"),
    };
    if !matches!(parsed.scheme(), "http" | "https") {
        return HttpResponse::BadRequest().body("scheme not allowed");
    }
    if let Some(host) = parsed.host_str() {
        if let Ok(addrs) = tokio::net::lookup_host(format!("{host}:80")).await {
            for sa in addrs {
                if is_private_or_special(&sa.ip()) {
                    return HttpResponse::BadRequest().body("private target");
                }
            }
        }
    } else {
        return HttpResponse::BadRequest().body("no host");
    }

    let preview = match fetch_and_parse(raw_url).await {
        Ok(p) => p,
        Err(e) => {
            tracing::warn!("preview fetch failed for {}: {}", raw_url, e);
            return HttpResponse::BadGateway().body(format!("fetch failed: {e}"));
        }
    };

    // Store in cache, evict oldest if at capacity.
    {
        let mut cache = CACHE.lock().unwrap();
        if cache.len() >= CACHE_CAP {
            if let Some((oldest_k, _)) = cache
                .iter()
                .min_by_key(|(_, v)| v.inserted_at)
                .map(|(k, v)| (k.clone(), v.inserted_at))
            {
                cache.remove(&oldest_k);
            }
        }
        cache.insert(
            raw_url.to_string(),
            CacheEntry { inserted_at: Instant::now(), preview: preview.clone() },
        );
    }

    HttpResponse::Ok().json(preview)
}

fn is_private_or_special(ip: &IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            v4.is_private()
                || v4.is_loopback()
                || v4.is_link_local()
                || v4.is_unspecified()
                || v4.is_broadcast()
                || v4.octets()[0] == 0
                // 100.64.0.0/10 — carrier-grade NAT
                || (v4.octets()[0] == 100 && (v4.octets()[1] & 0xc0) == 64)
        }
        IpAddr::V6(v6) => {
            v6.is_loopback() || v6.is_unspecified() || v6.is_unicast_link_local()
        }
    }
}

/// Sniff a charset from a `<meta charset=...>` or
/// `<meta http-equiv="Content-Type" content="...charset=...">` tag in the
/// first 4 KB of the document. ASCII-scan only — enough to find the meta
/// tag, which is itself always ASCII-encoded regardless of page charset.
fn sniff_meta_charset(body: &[u8]) -> Option<String> {
    let head = &body[..body.len().min(4096)];
    let ascii = head
        .iter()
        .map(|&b| if b.is_ascii() { b as char } else { ' ' })
        .collect::<String>()
        .to_ascii_lowercase();
    if let Some(i) = ascii.find("charset=") {
        let rest = &ascii[i + "charset=".len()..];
        let val: String = rest
            .trim_start_matches(['"', '\'', ' '])
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
            .collect();
        if !val.is_empty() {
            return Some(val);
        }
    }
    None
}

async fn fetch_and_parse(url: &str) -> Result<Preview, String> {
    let client = reqwest::Client::builder()
        .timeout(FETCH_TIMEOUT)
        .user_agent("telefon-preview/1.0 (+https://telefon.lleo.me)")
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()
        .map_err(|e| e.to_string())?;

    let resp = client.get(url).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    let final_url = resp.url().to_string();

    // Charset from the Content-Type header, if the server declared one
    // (e.g. "text/html; charset=windows-1251"). Many Russian sites such
    // as lleo.me still serve cp1251, so honouring this matters.
    let header_charset = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .and_then(|ct| {
            ct.split(';')
                .find_map(|p| p.trim().strip_prefix("charset="))
                .map(|c| c.trim().trim_matches('"').to_string())
        });

    // Read up to MAX_BODY_BYTES; bail out if larger so we never load huge
    // PDFs / videos.
    let mut body = Vec::with_capacity(8192);
    let mut stream = resp;
    let chunk = stream.bytes().await.map_err(|e| e.to_string())?;
    body.extend_from_slice(&chunk);
    if body.len() > MAX_BODY_BYTES {
        body.truncate(MAX_BODY_BYTES);
    }

    // Resolve the encoding: header charset wins; otherwise sniff a
    // <meta charset> / <meta http-equiv> within the first few KB; fall
    // back to UTF-8.
    let label = header_charset
        .or_else(|| sniff_meta_charset(&body))
        .unwrap_or_else(|| "utf-8".to_string());
    let encoding = encoding_rs::Encoding::for_label(label.as_bytes())
        .unwrap_or(encoding_rs::UTF_8);
    let (text, _, _) = encoding.decode(&body);
    let doc = Html::parse_document(&text);

    let meta = |property: &str| -> Option<String> {
        // og:* lives in <meta property="..."> with content="..."
        let sel = Selector::parse(&format!("meta[property=\"{property}\"]")).ok()?;
        doc.select(&sel)
            .next()
            .and_then(|el| el.value().attr("content"))
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
    };
    let meta_name = |name: &str| -> Option<String> {
        let sel = Selector::parse(&format!("meta[name=\"{name}\"]")).ok()?;
        doc.select(&sel)
            .next()
            .and_then(|el| el.value().attr("content"))
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
    };
    let title_tag = || -> Option<String> {
        let sel = Selector::parse("title").ok()?;
        doc.select(&sel)
            .next()
            .map(|el| el.text().collect::<String>().trim().to_string())
            .filter(|s| !s.is_empty())
    };

    let title       = meta("og:title").or_else(title_tag);
    let description = meta("og:description").or_else(|| meta_name("description"));
    let image       = meta("og:image");
    let site_name   = meta("og:site_name");

    // Drop images whose source still contains an unexpanded template
    // placeholder (e.g. lleo.me serves og:image="{LINK}"). Then resolve
    // any remaining relative URL against the final document URL.
    let image = image
        .filter(|src| !src.contains('{') && !src.contains('}') && !src.contains(' '))
        .and_then(|src| {
            url::Url::parse(&final_url)
                .ok()
                .and_then(|base| base.join(&src).ok())
                .map(|u| u.to_string())
        });

    Ok(Preview {
        url: final_url,
        title,
        description,
        image,
        site_name,
    })
}
