package com.dashota

import android.util.Base64
import com.github.luben.zstd.Zstd
import com.google.crypto.tink.subtle.Ed25519Verify
import java.io.File
import java.security.MessageDigest
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * Trust-critical crypto, mirroring the shared `openRelease` reference. Ed25519 verification
 * uses Google **Tink** (package-based) with the raw 32-byte embedded public key; AES-256-GCM,
 * SHA-256 and HMAC use the JDK directly; zstd comes from zstd-jni.
 */
object DashOtaCrypto {
  fun b64(s: String): ByteArray = Base64.decode(s, Base64.DEFAULT)

  /** Verify against any embedded key (key ring); true if one validates. */
  fun ed25519VerifyAny(publicKeysB64: List<String>, message: ByteArray, signature: ByteArray): Boolean {
    for (key in publicKeysB64) {
      if (key.isBlank()) continue
      try {
        Ed25519Verify(b64(key)).verify(signature, message)
        return true
      } catch (_: Exception) {
        // try the next key in the ring
      }
    }
    return false
  }

  /** AES-256-GCM decrypt (throws if the tag fails to authenticate). */
  /**
   * Decrypt one blob.
   *
   * @param aad additional authenticated data — `bundleId + "/" + fileSha256`, binding the blob to
   *   its release and to the plaintext it claims to be. A mismatch fails the tag, so a blob cannot
   *   be lifted from another release or swapped for a different file within this one.
   * @throws javax.crypto.AEADBadTagException on any tampering.
   */
  fun aesGcmDecrypt(key: ByteArray, iv: ByteArray, ciphertext: ByteArray, tag: ByteArray, aad: ByteArray?): ByteArray {
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, iv))
    if (aad != null) cipher.updateAAD(aad)
    // doFinal, never CipherInputStream: several implementations of that stream swallow
    // AEADBadTagException at end of stream and hand back truncated plaintext, which would accept a
    // tampered blob silently.
    return cipher.doFinal(ciphertext + tag)
  }

  /**
   * Decompress a zstd blob, bounded by the size the signed manifest promises.
   *
   * The frame declares its own decompressed size, so a bomb (a few KB expanding to hundreds of MB)
   * is refused before anything is allocated rather than after it has already exhausted memory.
   *
   * @param data compressed bytes.
   * @param expectedSize plaintext size from the manifest.
   */
  fun zstdDecompress(data: ByteArray, expectedSize: Int): ByteArray {
    val declared = Zstd.decompressedSize(data)
    if (declared <= 0L) throw RuntimeException("zstd frame declares no content size")
    if (declared != expectedSize.toLong()) {
      throw RuntimeException("zstd frame declares $declared bytes, manifest says $expectedSize")
    }
    val out = Zstd.decompress(data, expectedSize)
    if (Zstd.isError(out.size.toLong())) throw RuntimeException("zstd decompress failed")
    return out
  }

  /** Streaming SHA-256 of a file, so a large blob is never held in memory just to be hashed. */
  fun sha256HexOfFile(file: File): String {
    val digest = MessageDigest.getInstance("SHA-256")
    file.inputStream().use { input ->
      val buf = ByteArray(64 * 1024)
      while (true) {
        val n = input.read(buf)
        if (n < 0) break
        digest.update(buf, 0, n)
      }
    }
    return toHex(digest.digest())
  }

  fun sha256(bytes: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(bytes)
  fun sha256Hex(bytes: ByteArray): String = toHex(sha256(bytes))

  fun hmacSha256Hex(key: ByteArray, message: ByteArray): String {
    val mac = Mac.getInstance("HmacSHA256")
    mac.init(SecretKeySpec(key, "HmacSHA256"))
    return toHex(mac.doFinal(message))
  }

  fun toHex(bytes: ByteArray): String {
    val sb = StringBuilder(bytes.size * 2)
    for (b in bytes) sb.append(String.format("%02x", b))
    return sb.toString()
  }

  }
