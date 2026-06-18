package com.dashota

import android.util.Base64
import com.google.crypto.tink.subtle.Ed25519Verify
import org.json.JSONArray
import java.security.MessageDigest
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * Trust-critical crypto, mirroring the shared `openRelease` reference. Ed25519 verification
 * uses Google **Tink** (package-based) with the raw 32-byte embedded public key; AES-256-GCM,
 * SHA-256 and HMAC use the JDK directly. SOA1 is the package archive format.
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
  fun aesGcmDecrypt(key: ByteArray, iv: ByteArray, ciphertext: ByteArray, tag: ByteArray): ByteArray {
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, iv))
    val combined = ByteArray(ciphertext.size + tag.size)
    System.arraycopy(ciphertext, 0, combined, 0, ciphertext.size)
    System.arraycopy(tag, 0, combined, ciphertext.size, tag.size)
    return cipher.doFinal(combined)
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

  /** Unpack a "SOA1" archive: magic(4) + uint32BE headerLen + header JSON [{path,size}] + blobs. */
  fun unpackArchive(buf: ByteArray): List<Pair<String, ByteArray>> {
    require(buf.size >= 8 && String(buf, 0, 4, Charsets.US_ASCII) == "SOA1") { "bad archive magic" }
    val headerLen = ((buf[4].toInt() and 0xff) shl 24) or
      ((buf[5].toInt() and 0xff) shl 16) or
      ((buf[6].toInt() and 0xff) shl 8) or
      (buf[7].toInt() and 0xff)
    val headerEnd = 8 + headerLen
    require(buf.size >= headerEnd) { "truncated archive header" }
    val header = JSONArray(String(buf, 8, headerLen, Charsets.UTF_8))
    val out = ArrayList<Pair<String, ByteArray>>(header.length())
    var offset = headerEnd
    for (i in 0 until header.length()) {
      val entry = header.getJSONObject(i)
      val size = entry.getInt("size")
      require(buf.size >= offset + size) { "truncated archive blob" }
      out.add(Pair(entry.getString("path"), buf.copyOfRange(offset, offset + size)))
      offset += size
    }
    return out
  }
}
