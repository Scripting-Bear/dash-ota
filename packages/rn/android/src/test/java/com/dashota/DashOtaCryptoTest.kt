package com.dashota

import com.github.luben.zstd.Zstd
import java.io.File
import java.security.SecureRandom
import javax.crypto.AEADBadTagException
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/**
 * The blob unpacking path: decrypt, decompress, verify.
 *
 * These run on the JVM against the real ciphers and the real zstd, and they exist because this is
 * the code that only ever ran on a device — a v2 release was never successfully downloaded until
 * the emulator run on 2026-09-10, and the defect that blocked it compiled and type-checked fine.
 *
 * Everything is file-to-file on purpose: a decompressed Hermes bundle is the single largest
 * allocation the update path could make, and it is never held in memory.
 */
class DashOtaCryptoTest {
  @get:Rule val temp = TemporaryFolder()

  private val key = ByteArray(32).also { SecureRandom().nextBytes(it) }
  private val iv = ByteArray(12).also { SecureRandom().nextBytes(it) }

  /** Compress then seal, exactly as the publisher does. Returns ciphertext and tag separately. */
  private fun seal(plain: ByteArray, aad: ByteArray): Pair<ByteArray, ByteArray> {
    val compressed = Zstd.compress(plain, 3)
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, iv))
    cipher.updateAAD(aad)
    val sealed = cipher.doFinal(compressed)
    return sealed.copyOfRange(0, sealed.size - 16) to sealed.copyOfRange(sealed.size - 16, sealed.size)
  }

  private fun file(name: String, bytes: ByteArray): File =
    temp.newFile(name).also { it.writeBytes(bytes) }

  @Test
  fun `a sealed blob round-trips to the original bytes`() {
    val plain = ByteArray(300_000) { (it % 251).toByte() }
    val aad = DashOtaCrypto.sha256Hex(plain).toByteArray()
    val (ciphertext, tag) = seal(plain, aad)

    val decrypted = File(temp.root, "blob.dec")
    DashOtaCrypto.aesGcmDecryptToFile(key, iv, file("blob.part", ciphertext), tag, aad, decrypted)
    val out = File(temp.root, "out.bin")
    val sha = DashOtaCrypto.zstdDecompressToFile(decrypted, out, plain.size)

    assertArrayEquals(plain, out.readBytes())
    assertEquals(DashOtaCrypto.sha256Hex(plain), sha)
  }

  @Test
  fun `a flipped ciphertext byte fails the tag and leaves nothing behind`() {
    val plain = ByteArray(50_000) { it.toByte() }
    val aad = DashOtaCrypto.sha256Hex(plain).toByteArray()
    val (ciphertext, tag) = seal(plain, aad)
    val victim = ciphertext.size / 2
    ciphertext[victim] = (ciphertext[victim].toInt() xor 0xff).toByte()

    val dest = File(temp.root, "blob.dec")
    var threw = false
    try {
      DashOtaCrypto.aesGcmDecryptToFile(key, iv, file("blob.part", ciphertext), tag, aad, dest)
    } catch (_: AEADBadTagException) {
      threw = true
    }
    assertTrue("tampering must fail the tag", threw)
    assertFalse("unauthenticated plaintext must not survive on disk", dest.exists())
  }

  @Test
  fun `a blob sealed for a different file is rejected by the aad`() {
    val plain = ByteArray(20_000) { it.toByte() }
    val (ciphertext, tag) = seal(plain, DashOtaCrypto.sha256Hex(plain).toByteArray())

    val dest = File(temp.root, "blob.dec")
    var threw = false
    try {
      // Same key, same bytes, but claimed as a different file.
      DashOtaCrypto.aesGcmDecryptToFile(key, iv, file("blob.part", ciphertext), tag, "some other file".toByteArray(), dest)
    } catch (_: AEADBadTagException) {
      threw = true
    }
    assertTrue("the aad must bind the blob to its plaintext identity", threw)
    assertFalse(dest.exists())
  }

  @Test
  fun `a decompression bomb is refused from the frame header alone`() {
    // 8 MB of zeros compresses to a few hundred bytes. A manifest claiming it is tiny must be
    // refused before any of it is written.
    val bomb = Zstd.compress(ByteArray(8 * 1024 * 1024), 3)
    val out = File(temp.root, "out.bin")
    var message = ""
    try {
      DashOtaCrypto.zstdDecompressToFile(file("bomb.zst", bomb), out, 1024)
    } catch (e: Exception) {
      message = e.message ?: ""
    }
    assertTrue("expected a frame-size refusal, got: $message", message.contains("declares"))
    assertFalse(out.exists())
  }

  @Test
  fun `a truncated frame does not leave a short file in place`() {
    val plain = ByteArray(100_000) { it.toByte() }
    val compressed = Zstd.compress(plain, 3)
    val truncated = compressed.copyOfRange(0, compressed.size / 2)
    val out = File(temp.root, "out.bin")
    var threw = false
    try {
      DashOtaCrypto.zstdDecompressToFile(file("short.zst", truncated), out, plain.size)
    } catch (_: Exception) {
      threw = true
    }
    assertTrue("a truncated frame must fail", threw)
    assertFalse("a partial file must never survive for a resume to trust", out.exists())
  }
}
