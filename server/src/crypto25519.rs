//! Crypto primitives reused from aguardia_server with two additions for
//! ws_server:
//!
//!   * `derive_session_keys` — HKDF expansion of the X25519 shared secret
//!     into two directional keys (client-to-server / server-to-client) used
//!     for routing-header obfuscation.
//!   * `xor_header_8` — ChaCha20 keystream XOR for the 8-byte routing
//!     header. The nonce is the first 12 bytes of the per-frame
//!     XChaCha20-Poly1305 nonce that's already on the wire.

use chacha20::ChaCha20;
use chacha20::cipher::{KeyIvInit, StreamCipher};
use chacha20poly1305::{Key, KeyInit, XChaCha20Poly1305, XNonce, aead::Aead};
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use rand::RngCore;
use rand::rngs::OsRng;
use std::time::{SystemTime, UNIX_EPOCH};
use x25519_dalek::{X25519_BASEPOINT_BYTES, x25519};

#[derive(Debug)]
pub enum CryptoError {
    BadSignature,
    BadFormat,
    BadCiphertext,
}

pub fn get_unixtime() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

pub fn fresh_nonce_24() -> [u8; 24] {
    let mut out = [0u8; 24];
    out[0..8].copy_from_slice(&get_unixtime().to_le_bytes());
    OsRng.fill_bytes(&mut out[8..24]);
    out
}

#[allow(dead_code)]
pub fn x25519_public_from_secret(secret: &[u8; 32]) -> [u8; 32] {
    x25519(*secret, X25519_BASEPOINT_BYTES)
}

pub fn x25519_shared(my_secret: &[u8; 32], their_public: &[u8; 32]) -> [u8; 32] {
    x25519(*my_secret, *their_public)
}

/// XChaCha20-Poly1305 AEAD encrypt, then Ed25519-sign (nonce || ciphertext).
///
/// Wire layout of the returned packet:
///   `[ nonce : 24 ] [ ciphertext : N ] [ ed25519_sig : 64 ]`
pub fn encrypt_and_sign(
    plaintext: &[u8],
    my_x_secret: &[u8; 32],
    my_ed_signing: &SigningKey,
    their_x_public: &[u8; 32],
) -> Result<Vec<u8>, CryptoError> {
    let nonce = fresh_nonce_24();
    let shared = x25519_shared(my_x_secret, their_x_public);
    let cipher = XChaCha20Poly1305::new(Key::from_slice(&shared));
    let ciphertext = cipher
        .encrypt(XNonce::from_slice(&nonce), plaintext)
        .map_err(|_| CryptoError::BadCiphertext)?;

    let mut packet = Vec::with_capacity(24 + ciphertext.len() + 64);
    packet.extend_from_slice(&nonce);
    packet.extend_from_slice(&ciphertext);
    let sig = my_ed_signing.sign(&packet).to_bytes();
    packet.extend_from_slice(&sig);
    Ok(packet)
}

/// Verify Ed25519 signature over (nonce || ciphertext), then AEAD-decrypt.
#[allow(dead_code)]
pub fn verify_and_decrypt(
    packet: &[u8],
    my_x_secret: &[u8; 32],
    their_x_public: &[u8; 32],
    their_ed_public: &VerifyingKey,
) -> Result<Vec<u8>, CryptoError> {
    const NONCE_LEN: usize = 24;
    const SIG_LEN: usize = 64;
    const TAG_LEN: usize = 16;

    if packet.len() <= NONCE_LEN + SIG_LEN + TAG_LEN {
        return Err(CryptoError::BadFormat);
    }
    let (nonce_and_cipher, sig_bytes) = packet.split_at(packet.len() - SIG_LEN);
    let sig = Signature::from_bytes(
        sig_bytes
            .try_into()
            .map_err(|_| CryptoError::BadFormat)?,
    );
    if their_ed_public.verify(nonce_and_cipher, &sig).is_err() {
        return Err(CryptoError::BadSignature);
    }

    let nonce_bytes: &[u8; 24] = nonce_and_cipher[..NONCE_LEN]
        .try_into()
        .map_err(|_| CryptoError::BadFormat)?;
    let ciphertext = &nonce_and_cipher[NONCE_LEN..];

    let shared = x25519_shared(my_x_secret, their_x_public);
    let cipher = XChaCha20Poly1305::new(Key::from_slice(&shared));
    cipher
        .decrypt(XNonce::from_slice(nonce_bytes), ciphertext)
        .map_err(|_| CryptoError::BadCiphertext)
}

/// BLAKE3 derive_key (RFC-style domain separation) producing two
/// directional 32-byte keys from one ECDH shared secret. Context strings
/// are part of the v2 protocol — clients must use the same literals.
pub fn derive_session_keys(shared: &[u8; 32]) -> ([u8; 32], [u8; 32]) {
    let k_c2s = blake3::derive_key("ws.lleo.me v2 route c2s", shared);
    let k_s2c = blake3::derive_key("ws.lleo.me v2 route s2c", shared);
    (k_c2s, k_s2c)
}

/// XOR an 8-byte routing header with a fresh ChaCha20 keystream block,
/// keyed by `key` and nonce derived from the first 12 bytes of `nonce_24`.
///
/// Symmetric: applying twice with the same key and nonce yields the
/// original bytes.
pub fn xor_header_8(key: &[u8; 32], nonce_24: &[u8; 24], header: &mut [u8; 8]) {
    let nonce12: &[u8; 12] = nonce_24[..12].try_into().expect("12 <= 24");
    let mut cipher = ChaCha20::new(key.into(), nonce12.into());
    cipher.apply_keystream(header);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn aead_and_sig_roundtrip() {
        let mut alice_x_seed = [0u8; 32];
        OsRng.fill_bytes(&mut alice_x_seed);
        let alice_x_secret = {
            let mut s = alice_x_seed;
            s[0] &= 248;
            s[31] &= 127;
            s[31] |= 64;
            s
        };
        let alice_x_public = x25519_public_from_secret(&alice_x_secret);
        let alice_ed_seed = [9u8; 32];
        let alice_ed = SigningKey::from_bytes(&alice_ed_seed);
        let alice_ed_pub = alice_ed.verifying_key();

        let mut bob_x_seed = [0u8; 32];
        OsRng.fill_bytes(&mut bob_x_seed);
        let bob_x_secret = {
            let mut s = bob_x_seed;
            s[0] &= 248;
            s[31] &= 127;
            s[31] |= 64;
            s
        };
        let bob_x_public = x25519_public_from_secret(&bob_x_secret);

        let plaintext = b"Hello over the wire";
        let packet =
            encrypt_and_sign(plaintext, &alice_x_secret, &alice_ed, &bob_x_public).unwrap();
        let recovered =
            verify_and_decrypt(&packet, &bob_x_secret, &alice_x_public, &alice_ed_pub).unwrap();
        assert_eq!(recovered, plaintext);
    }

    #[test]
    fn xor_header_is_symmetric() {
        let key = [0x42u8; 32];
        let nonce = [0x11u8; 24];
        let mut header = *b"\x01\x02\x03\x04\x05\x06\x07\x08";
        let original = header;
        xor_header_8(&key, &nonce, &mut header);
        assert_ne!(header, original);
        xor_header_8(&key, &nonce, &mut header);
        assert_eq!(header, original);
    }

    #[test]
    fn derive_keys_are_deterministic_and_distinct() {
        let shared = [0xabu8; 32];
        let (a1, b1) = derive_session_keys(&shared);
        let (a2, b2) = derive_session_keys(&shared);
        assert_eq!(a1, a2);
        assert_eq!(b1, b2);
        assert_ne!(a1, b1);
    }

    #[test]
    fn verify_verifying_key_module() {
        // Make sure ed25519 verify path still compiles cleanly against the
        // signature/verifying-key types we use elsewhere.
        let sk = SigningKey::from_bytes(&[7u8; 32]);
        let vk: VerifyingKey = sk.verifying_key();
        let msg = b"sample";
        let sig: Signature = sk.sign(msg);
        assert!(vk.verify(msg, &sig).is_ok());
    }
}
