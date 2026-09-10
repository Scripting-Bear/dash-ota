package com.dashota

import android.util.Base64
import com.github.luben.zstd.Zstd
import com.github.luben.zstd.ZstdInputStreamNoFinalizer
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
  /** Enough of a zstd frame to carry the header and its declared content size. */
  private const val HEADER_PROBE_BYTES = 32

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

  /**
   * Decrypt one blob from a file into a file.
   *
   * JCE cannot stream GCM decryption. `Cipher.update` releases nothing during decryption — it
   * buffers the whole ciphertext internally, because the tag is only known at the end and the API
   * will not hand back plaintext it has not authenticated. Measured: `update` returned 0 bytes for
   * a 1 MB message, `doFinal` returned all of it. So one copy of the *compressed* blob is
   * unavoidable here; what this avoids is also holding the decompressed file, which for a Hermes
   * bundle is several times larger — see [zstdDecompressToFile].
   *
   * Any bytes a provider does release early are written as they arrive, so this is no worse if one
   * ever does stream. `dest` is deleted if authentication fails, and the caller re-checks the
   * plaintext hash against the signed manifest regardless.
   *
   * @param key the content key.
   * @param iv this blob's nonce.
   * @param src the downloaded, hash-verified ciphertext.
   * @param tag the GCM tag from the manifest.
   * @param aad additional authenticated data — the plaintext hash, binding the blob to the file it
   *   claims to be. Not the release: one blob is shared by every release containing that file.
   * @param dest written with the decrypted bytes.
   * @throws javax.crypto.AEADBadTagException on any tampering.
   */
  fun aesGcmDecryptToFile(key: ByteArray, iv: ByteArray, src: File, tag: ByteArray, aad: ByteArray?, dest: File) {
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, iv))
    if (aad != null) cipher.updateAAD(aad)
    try {
      dest.outputStream().use { out ->
        src.inputStream().use { input ->
          val buf = ByteArray(64 * 1024)
          while (true) {
            val n = input.read(buf)
            if (n < 0) break
            val chunk = cipher.update(buf, 0, n)
            if (chunk != null && chunk.isNotEmpty()) out.write(chunk)
          }
        }
        // doFinal, never CipherInputStream: several implementations of that stream swallow
        // AEADBadTagException at end of stream and hand back truncated plaintext.
        val last = cipher.doFinal(tag)
        if (last.isNotEmpty()) out.write(last)
      }
    } catch (e: Exception) {
      dest.delete()
      throw e
    }
  }

  /**
   * Decompress a zstd blob from a file into a file, hashing as it goes.
   *
   * Streamed, so peak memory is one buffer no matter how large the bundle is. Bounded twice: the
   * frame header is checked against the size the signed manifest promises before any work starts,
   * which refuses a decompression bomb after a few bytes, and the output is counted as it is
   * written so a frame that lies about its own size cannot overrun the limit either.
   *
   * @param src compressed bytes.
   * @param dest written with the plaintext.
   * @param expectedSize plaintext size from the manifest.
   * @return hex sha-256 of what was written, for the caller to check against the manifest.
   */
  fun zstdDecompressToFile(src: File, dest: File, expectedSize: Int): String {
    val header = ByteArray(HEADER_PROBE_BYTES)
    val headerLength = src.inputStream().use { it.read(header) }
    if (headerLength <= 0) throw RuntimeException("zstd blob is empty")
    val declared = Zstd.getFrameContentSize(header, 0, headerLength)
    if (declared <= 0L) throw RuntimeException("zstd frame declares no content size")
    if (declared != expectedSize.toLong()) {
      throw RuntimeException("zstd frame declares $declared bytes, manifest says $expectedSize")
    }

    val digest = MessageDigest.getInstance("SHA-256")
    var total = 0L
    try {
      dest.outputStream().use { out ->
        ZstdInputStreamNoFinalizer(src.inputStream().buffered()).use { input ->
          val buf = ByteArray(64 * 1024)
          while (true) {
            val n = input.read(buf)
            if (n < 0) break
            total += n
            if (total > expectedSize) throw RuntimeException("zstd frame expanded past the $expectedSize bytes the manifest promised")
            digest.update(buf, 0, n)
            out.write(buf, 0, n)
          }
        }
      }
    } catch (e: Exception) {
      dest.delete()
      throw e
    }
    if (total != expectedSize.toLong()) {
      dest.delete()
      throw RuntimeException("zstd produced $total bytes, manifest says $expectedSize")
    }
    return toHex(digest.digest())
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
