package me.lleo.telefon.crypto

import org.bouncycastle.crypto.agreement.X25519Agreement
import org.bouncycastle.crypto.digests.Blake3Digest
import org.bouncycastle.crypto.engines.ChaCha7539Engine
import org.bouncycastle.crypto.modes.ChaCha20Poly1305
import org.bouncycastle.crypto.params.AEADParameters
import org.bouncycastle.crypto.params.Blake3Parameters
import org.bouncycastle.crypto.params.Ed25519PrivateKeyParameters
import org.bouncycastle.crypto.params.Ed25519PublicKeyParameters
import org.bouncycastle.crypto.params.KeyParameter
import org.bouncycastle.crypto.params.ParametersWithIV
import org.bouncycastle.crypto.params.X25519PrivateKeyParameters
import org.bouncycastle.crypto.params.X25519PublicKeyParameters
import org.bouncycastle.crypto.signers.Ed25519Signer
import java.security.SecureRandom

/**
 * Hardcoded server identity keys, see PROTOCOL.md.
 */
object ServerKeys {
    val X_PUB: ByteArray = hexToBytes(
        "4e8250d28b9b28836aadf6497535ef01056f19982d08ba4059b5c93537c80f06"
    )
    val ED_PUB: ByteArray = hexToBytes(
        "b835840fd3aba7cc4519513f3bbcb1c35170f6aa97d97c16eabdb2e36710d003"
    )
}

const val PROTOCOL_VERSION: Byte = 2

// Reserved command codes.
const val CMD_HANDSHAKE_REQUEST: Byte = 0x01
const val CMD_HANDSHAKE_OK: Byte = 0x02
const val CMD_TEXT: Byte = 0x20
const val CMD_SOUND_START: Byte = 0x21
const val CMD_SOUND_STOP: Byte = 0x22
const val CMD_SOUND_STOP_ALL: Byte = 0x23
const val CMD_ERROR: Byte = 0xFF.toByte()

const val ERR_ID_IN_USE: Byte = 0x01
const val ERR_BAD_VERSION: Byte = 0x02
const val ERR_RECIPIENT_OFFLINE: Byte = 0x03

/* --------------------------------------------------------------------- */
/*  Hex helpers                                                           */
/* --------------------------------------------------------------------- */

fun hexToBytes(hex: String): ByteArray {
    require(hex.length % 2 == 0) { "odd hex length" }
    val out = ByteArray(hex.length / 2)
    for (i in out.indices) {
        out[i] = ((Character.digit(hex[i * 2], 16) shl 4)
                or Character.digit(hex[i * 2 + 1], 16)).toByte()
    }
    return out
}

fun bytesToHex(bytes: ByteArray): String {
    val hex = "0123456789abcdef"
    val sb = StringBuilder(bytes.size * 2)
    for (b in bytes) {
        val v = b.toInt() and 0xff
        sb.append(hex[v ushr 4]).append(hex[v and 0x0f])
    }
    return sb.toString()
}

/* --------------------------------------------------------------------- */
/*  X25519 keypair + agreement                                            */
/* --------------------------------------------------------------------- */

data class X25519KeyPair(val priv: ByteArray, val pub: ByteArray)

object X25519 {
    private val rng = SecureRandom()

    fun generate(): X25519KeyPair {
        val sk = X25519PrivateKeyParameters(rng)
        val pk = sk.generatePublicKey()
        return X25519KeyPair(sk.encoded, pk.encoded)
    }

    fun fromPrivate(priv: ByteArray): X25519KeyPair {
        val sk = X25519PrivateKeyParameters(priv, 0)
        val pk = sk.generatePublicKey()
        return X25519KeyPair(sk.encoded, pk.encoded)
    }

    fun agree(priv: ByteArray, peerPub: ByteArray): ByteArray {
        val agreement = X25519Agreement()
        agreement.init(X25519PrivateKeyParameters(priv, 0))
        val out = ByteArray(agreement.agreementSize)
        agreement.calculateAgreement(X25519PublicKeyParameters(peerPub, 0), out, 0)
        return out
    }
}

/* --------------------------------------------------------------------- */
/*  Ed25519 sign / verify                                                 */
/* --------------------------------------------------------------------- */

data class Ed25519KeyPair(val priv: ByteArray, val pub: ByteArray)

object Ed25519 {
    private val rng = SecureRandom()

    fun generate(): Ed25519KeyPair {
        val sk = Ed25519PrivateKeyParameters(rng)
        val pk = sk.generatePublicKey()
        return Ed25519KeyPair(sk.encoded, pk.encoded)
    }

    fun fromPrivate(priv: ByteArray): Ed25519KeyPair {
        val sk = Ed25519PrivateKeyParameters(priv, 0)
        val pk = sk.generatePublicKey()
        return Ed25519KeyPair(sk.encoded, pk.encoded)
    }

    fun sign(priv: ByteArray, msg: ByteArray): ByteArray {
        val signer = Ed25519Signer()
        signer.init(true, Ed25519PrivateKeyParameters(priv, 0))
        signer.update(msg, 0, msg.size)
        return signer.generateSignature()
    }

    fun verify(pub: ByteArray, msg: ByteArray, sig: ByteArray): Boolean {
        val signer = Ed25519Signer()
        signer.init(false, Ed25519PublicKeyParameters(pub, 0))
        signer.update(msg, 0, msg.size)
        return signer.verifySignature(sig)
    }
}

/* --------------------------------------------------------------------- */
/*  BLAKE3 derive_key                                                     */
/*                                                                        */
/*  Spec: draft-irtf-cfrg-blake3 §2.3. Two-stage construction with        */
/*  DERIVE_KEY_CONTEXT / DERIVE_KEY_MATERIAL flags. BouncyCastle 1.78+    */
/*  exposes this via Blake3Parameters.context(...).                       */
/* --------------------------------------------------------------------- */

object Blake3Kdf {
    /** Derive a `length`-byte key from `keyMaterial` in domain `context`. */
    fun deriveKey(context: String, keyMaterial: ByteArray, length: Int = 32): ByteArray {
        val params = Blake3Parameters.context(context.toByteArray(Charsets.UTF_8))
        val digest = Blake3Digest(length * 8)
        digest.init(params)
        digest.update(keyMaterial, 0, keyMaterial.size)
        val out = ByteArray(length)
        digest.doFinal(out, 0)
        return out
    }
}

/* --------------------------------------------------------------------- */
/*  XChaCha20-Poly1305                                                    */
/*                                                                        */
/*  BouncyCastle 1.78.1 ships ChaCha20Poly1305 with the IETF 12-byte      */
/*  nonce. Extended-nonce XChaCha20 is constructed from it via HChaCha20: */
/*                                                                        */
/*    subkey  = HChaCha20(key, nonce[0..16])                              */
/*    aead_nonce = b"\x00\x00\x00\x00" || nonce[16..24]                   */
/*    cipher  = ChaCha20Poly1305(subkey, aead_nonce)                      */
/*                                                                        */
/*  Reference: draft-irtf-cfrg-xchacha-03 (XChaCha20-Poly1305).           */
/* --------------------------------------------------------------------- */

object XChaCha20Poly1305 {

    fun encrypt(key: ByteArray, nonce24: ByteArray, plaintext: ByteArray): ByteArray {
        require(key.size == 32) { "key must be 32 bytes" }
        require(nonce24.size == 24) { "nonce must be 24 bytes" }
        val subkey = hChaCha20(key, nonce24.copyOfRange(0, 16))
        val aeadNonce = ByteArray(12).apply {
            // 4 zero bytes, then nonce[16..24]
            System.arraycopy(nonce24, 16, this, 4, 8)
        }
        val aead = ChaCha20Poly1305()
        aead.init(true, AEADParameters(KeyParameter(subkey), 128, aeadNonce))
        val out = ByteArray(aead.getOutputSize(plaintext.size))
        val n = aead.processBytes(plaintext, 0, plaintext.size, out, 0)
        aead.doFinal(out, n)
        return out
    }

    fun decrypt(key: ByteArray, nonce24: ByteArray, ciphertext: ByteArray): ByteArray? {
        require(key.size == 32) { "key must be 32 bytes" }
        require(nonce24.size == 24) { "nonce must be 24 bytes" }
        if (ciphertext.size < 16) return null
        val subkey = hChaCha20(key, nonce24.copyOfRange(0, 16))
        val aeadNonce = ByteArray(12).apply {
            System.arraycopy(nonce24, 16, this, 4, 8)
        }
        val aead = ChaCha20Poly1305()
        aead.init(false, AEADParameters(KeyParameter(subkey), 128, aeadNonce))
        val out = ByteArray(aead.getOutputSize(ciphertext.size))
        return try {
            val n = aead.processBytes(ciphertext, 0, ciphertext.size, out, 0)
            val m = aead.doFinal(out, n)
            out.copyOf(n + m)
        } catch (e: Exception) {
            null
        }
    }
}

/**
 * HChaCha20 sub-key derivation. Input: 32-byte key, 16-byte nonce.
 * Output: 32-byte sub-key. Standard construction from
 * draft-irtf-cfrg-xchacha-03 §2.2.
 */
internal fun hChaCha20(key: ByteArray, nonce16: ByteArray): ByteArray {
    require(key.size == 32)
    require(nonce16.size == 16)

    // ChaCha20 state: constants || key (8 words) || nonce (4 words)
    val state = IntArray(16)
    state[0] = 0x61707865
    state[1] = 0x3320646e
    state[2] = 0x79622d32
    state[3] = 0x6b206574
    for (i in 0 until 8) {
        state[4 + i] = leInt(key, i * 4)
    }
    for (i in 0 until 4) {
        state[12 + i] = leInt(nonce16, i * 4)
    }

    val x = state.copyOf()
    repeat(10) {
        // Column rounds
        quarterRound(x, 0, 4, 8, 12)
        quarterRound(x, 1, 5, 9, 13)
        quarterRound(x, 2, 6, 10, 14)
        quarterRound(x, 3, 7, 11, 15)
        // Diagonal rounds
        quarterRound(x, 0, 5, 10, 15)
        quarterRound(x, 1, 6, 11, 12)
        quarterRound(x, 2, 7, 8, 13)
        quarterRound(x, 3, 4, 9, 14)
    }

    // HChaCha20: take x[0..4] and x[12..16] (no addition to original state).
    val out = ByteArray(32)
    for (i in 0 until 4) leIntPut(out, i * 4, x[i])
    for (i in 0 until 4) leIntPut(out, 16 + i * 4, x[12 + i])
    return out
}

private fun quarterRound(s: IntArray, a: Int, b: Int, c: Int, d: Int) {
    s[a] = s[a] + s[b]; s[d] = Integer.rotateLeft(s[d] xor s[a], 16)
    s[c] = s[c] + s[d]; s[b] = Integer.rotateLeft(s[b] xor s[c], 12)
    s[a] = s[a] + s[b]; s[d] = Integer.rotateLeft(s[d] xor s[a], 8)
    s[c] = s[c] + s[d]; s[b] = Integer.rotateLeft(s[b] xor s[c], 7)
}

private fun leInt(buf: ByteArray, off: Int): Int =
    (buf[off].toInt() and 0xff) or
    ((buf[off + 1].toInt() and 0xff) shl 8) or
    ((buf[off + 2].toInt() and 0xff) shl 16) or
    ((buf[off + 3].toInt() and 0xff) shl 24)

private fun leIntPut(buf: ByteArray, off: Int, v: Int) {
    buf[off] = v.toByte()
    buf[off + 1] = (v ushr 8).toByte()
    buf[off + 2] = (v ushr 16).toByte()
    buf[off + 3] = (v ushr 24).toByte()
}

/* --------------------------------------------------------------------- */
/*  ChaCha20 stream cipher (IETF 12-byte nonce) — for XOR header.         */
/* --------------------------------------------------------------------- */

object ChaCha20Stream {
    /**
     * Apply 20-round ChaCha20 keystream (IETF variant, 12-byte nonce)
     * to [data] in place. The 32-bit counter starts at 0.
     */
    fun applyKeystream(key: ByteArray, nonce12: ByteArray, data: ByteArray) {
        require(key.size == 32) { "key must be 32 bytes" }
        require(nonce12.size == 12) { "nonce must be 12 bytes" }
        val engine = ChaCha7539Engine()
        engine.init(true, ParametersWithIV(KeyParameter(key), nonce12))
        engine.processBytes(data, 0, data.size, data, 0)
    }
}

/* --------------------------------------------------------------------- */
/*  ClientId — first 8 bytes of x_pub (X25519 pub is already random)      */
/* --------------------------------------------------------------------- */

fun clientIdFromXPub(xPub: ByteArray): ByteArray = xPub.copyOf(8)
