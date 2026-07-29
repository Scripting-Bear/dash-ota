package com.dashota

import android.util.Base64
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.security.SecureRandom
import javax.net.ssl.HttpsURLConnection

/**
 * The DashOta TurboModule. JS orchestrates; this implements the trust-critical native work:
 * download the ciphertext, Ed25519-verify the (canonical) manifest against the embedded key,
 * verify the ciphertext hash, AES-256-GCM decrypt, unpack, verify every file's hash, and stage
 * atomically. Fails closed on any error.
 */
class DashOtaModule(private val reactContext: ReactApplicationContext) :
  NativeDashOtaSpec(reactContext) {

  override fun getName(): String = NAME

  // --- Embedded per-flavour config ---
  override fun getRuntimeVersion(): String = DashOtaConfig.runtimeVersion(reactContext)
  override fun getChannel(): String = DashOtaConfig.channel(reactContext)
  override fun getServerUrl(): String = DashOtaConfig.serverUrl(reactContext)
  override fun getPublicKeysB64(): String = DashOtaConfig.publicKeysB64(reactContext)
  override fun getNativeBuildNumber(): Double = DashOtaConfig.nativeBuild(reactContext).toDouble()

  // --- State ---
  override fun getCurrentBundleMeta(promise: Promise) {
    try {
      val meta = DashOtaStore.currentMeta(reactContext)
      val map = Arguments.createMap()
      map.putString("bundleId", meta.getString("bundleId"))
      map.putDouble("bundleVersion", meta.getInt("bundleVersion").toDouble())
      map.putString("runtimeVersion", getRuntimeVersion())
      map.putBoolean("isEmbedded", meta.getBoolean("isEmbedded"))
      promise.resolve(map)
    } catch (e: Exception) {
      promise.reject("meta_error", e.message, e)
    }
  }

  override fun getState(promise: Promise) {
    try {
      val state = DashOtaStore.loadState(reactContext)
      val map = Arguments.createMap()
      map.putDouble("currentBundleVersion", DashOtaStore.currentBundleVersion(reactContext).toDouble())
      val pending = if (state.has("pending") && !state.isNull("pending")) state.getJSONObject("pending").optString("bundleId") else null
      if (pending != null) map.putString("pendingBundleId", pending) else map.putNull("pendingBundleId")
      val lkgVersion = if (state.has("lastKnownGood") && !state.isNull("lastKnownGood")) state.getJSONObject("lastKnownGood").optInt("version", 0) else 0
      map.putDouble("lastKnownGoodVersion", lkgVersion.toDouble())
      val currentBundleId = DashOtaStore.currentMeta(reactContext).optString("bundleId", "")
      map.putBoolean("otaDisabled", currentBundleId.isNotEmpty() && DashOtaStore.isDisabled(reactContext, currentBundleId))
      promise.resolve(map)
    } catch (e: Exception) {
      promise.reject("state_error", e.message, e)
    }
  }

  // --- Download + verify + stage (off the JS thread) ---
  override fun downloadAndStage(
    downloadUrl: String,
    downloadToken: String,
    manifestJson: String,
    signatureB64: String,
    promise: Promise,
  ) {
    Thread {
      var tmp: File? = null
      try {
        // 1. Ed25519-verify the canonical manifest bytes against the embedded key ring.
        val keys = getPublicKeysB64().split(",").map { it.trim() }.filter { it.isNotEmpty() }
        val manifestBytes = manifestJson.toByteArray(Charsets.UTF_8)
        if (!DashOtaCrypto.ed25519VerifyAny(keys, manifestBytes, DashOtaCrypto.b64(signatureB64))) {
          promise.reject("bad_signature", "manifest signature did not verify")
          return@Thread
        }
        val manifest = JSONObject(manifestJson)

        // 2. runtimeVersion gate (defense-in-depth; backend also enforces).
        if (manifest.getString("runtimeVersion") != getRuntimeVersion()) {
          promise.reject("runtime_mismatch", "bundle runtimeVersion does not match this binary")
          return@Thread
        }
        // 3. downgrade guard.
        val version = manifest.getInt("bundleVersion")
        if (version <= DashOtaStore.currentBundleVersion(reactContext)) {
          promise.reject("downgrade", "bundleVersion is not newer than current")
          return@Thread
        }
        val bundleId = manifest.getString("bundleId")
        // 3b. refuse a bundle the crash-loop breaker already disabled (don't re-download a known-bad one).
        if (DashOtaStore.isDisabled(reactContext, bundleId)) {
          promise.reject("bundle_disabled", "bundle was disabled after a crash loop")
          return@Thread
        }

        // The manifest is already Ed25519-verified, so its signed ciphertextSize is trustworthy —
        // use it to bound the download (closes a memory-DoS + rejects a MITM-swapped body early).
        val enc = manifest.getJSONObject("encryption")
        val expectedSize = enc.optLong("ciphertextSize", -1L)
        if (expectedSize < 0L) {
          promise.reject("bad_manifest", "manifest missing encryption.ciphertextSize")
          return@Thread
        }

        // 4. download ciphertext to a temp file, bounded to the signed size.
        tmp = File(DashOtaStore.tmpDir(reactContext), "$bundleId.bin")
        downloadTo(downloadUrl, downloadToken, tmp, expectedSize)
        val ciphertext = tmp.readBytes()

        // 5. ciphertext hash.
        if (DashOtaCrypto.sha256Hex(ciphertext) != enc.getString("ciphertextSha256")) {
          promise.reject("hash_mismatch", "ciphertext hash mismatch")
          return@Thread
        }

        // 6. decrypt + unpack.
        val archive = DashOtaCrypto.aesGcmDecrypt(
          DashOtaCrypto.b64(enc.getString("contentKeyB64")),
          DashOtaCrypto.b64(enc.getString("ivB64")),
          ciphertext,
          DashOtaCrypto.b64(enc.getString("tagB64")),
        )
        val files = DashOtaCrypto.unpackArchive(archive)

        // 7. per-file hash + size.
        val manifestFiles = manifest.getJSONArray("files")
        if (files.size != manifestFiles.length()) {
          promise.reject("file_count", "file count mismatch")
          return@Thread
        }
        val expected = HashMap<String, JSONObject>()
        for (i in 0 until manifestFiles.length()) {
          val fe = manifestFiles.getJSONObject(i)
          expected[fe.getString("path")] = fe
        }
        for ((path, data) in files) {
          val fe = expected[path]
          if (fe == null || data.size != fe.getInt("size") || DashOtaCrypto.sha256Hex(data) != fe.getString("sha256")) {
            promise.reject("file_mismatch", "file hash/size mismatch: $path")
            return@Thread
          }
        }

        // 8. stage atomically.
        DashOtaStore.stage(reactContext, bundleId, version, manifest.getString("runtimeVersion"), files)
        val map = Arguments.createMap()
        map.putString("bundleId", bundleId)
        map.putDouble("bundleVersion", version.toDouble())
        promise.resolve(map)
      } catch (e: Exception) {
        promise.reject("stage_failed", e.message, e)
      } finally {
        tmp?.delete()
      }
    }.start()
  }

  private fun downloadTo(urlStr: String, token: String, dest: File, expectedSize: Long) {
    val conn = URL(urlStr).openConnection() as HttpURLConnection
    conn.requestMethod = "GET"
    conn.setRequestProperty("x-ota-download-token", token)
    conn.connectTimeout = 15000
    conn.readTimeout = 30000
    try {
      // Optional certificate pinning (off unless ota_tls_pins is configured). Verify before any body.
      verifyPins(conn)
      if (conn.responseCode != 200) throw RuntimeException("download HTTP ${conn.responseCode}")
      // Reject a Content-Length that disagrees with the signed size before reading a single byte.
      val declared = conn.contentLengthLong
      if (declared >= 0L && declared != expectedSize) {
        throw RuntimeException("Content-Length $declared != signed ciphertextSize $expectedSize")
      }
      // Stream with a hard byte cap so a lying server can't exhaust memory/disk.
      conn.inputStream.use { input ->
        dest.outputStream().use { out ->
          val buf = ByteArray(64 * 1024)
          var total = 0L
          while (true) {
            val n = input.read(buf)
            if (n < 0) break
            total += n
            if (total > expectedSize) throw RuntimeException("download exceeded signed ciphertextSize $expectedSize")
            out.write(buf, 0, n)
          }
          if (total != expectedSize) throw RuntimeException("download truncated: $total != $expectedSize")
        }
      }
    } finally {
      conn.disconnect()
    }
  }

  /** Optional certificate pinning: reject the download unless a server cert matches a configured pin. */
  private fun verifyPins(conn: HttpURLConnection) {
    val pins = DashOtaConfig.tlsPins(reactContext).split(",").map { it.trim() }.filter { it.isNotEmpty() }
    if (pins.isEmpty()) return
    if (conn !is HttpsURLConnection) throw RuntimeException("TLS pinning is enabled but the download URL is not https")
    conn.connect()
    val md = MessageDigest.getInstance("SHA-256")
    val matched = conn.serverCertificates.any { cert ->
      pins.contains(Base64.encodeToString(md.digest(cert.encoded), Base64.NO_WRAP))
    }
    if (!matched) throw RuntimeException("TLS pin mismatch: server certificate not in the configured pin set")
  }

  override fun isBundleDisabled(bundleId: String): Boolean = DashOtaStore.isDisabled(reactContext, bundleId)

  override fun consumeFailedReport(): String = DashOtaStore.consumeFailedReport(reactContext)

  override fun applyOnNextLaunch(promise: Promise) {
    try {
      promise.resolve(DashOtaStore.promoteStagedToPending(reactContext))
    } catch (e: Exception) {
      promise.reject("apply_failed", e.message, e)
    }
  }

  override fun markHealthy() {
    try {
      DashOtaStore.markHealthy(reactContext)
    } catch (_: Exception) {
    }
  }

  override fun rollback(promise: Promise) {
    try {
      promise.resolve(DashOtaStore.rollback(reactContext))
    } catch (e: Exception) {
      promise.reject("rollback_failed", e.message, e)
    }
  }

  override fun restart() {
    // Best-effort only; the recommended path is apply-on-next-cold-start (see plan I3).
    try {
      val activity = reactContext.currentActivity ?: return
      activity.runOnUiThread { activity.recreate() }
    } catch (_: Exception) {
    }
  }

  // --- Hardware-backed device identity ---
  override fun getDevicePublicKeyB64(): String = DashOtaDeviceKey.publicKeyB64()

  override fun signWithDeviceKey(message: String): String =
    DashOtaDeviceKey.signB64(message.toByteArray(Charsets.UTF_8))

  override fun sha256Hex(message: String): String =
    DashOtaCrypto.sha256Hex(message.toByteArray(Charsets.UTF_8))

  /** Cryptographically-secure 16-byte nonce (base64url, unpadded) from SecureRandom, for anti-replay. */
  override fun generateNonce(): String {
    val bytes = ByteArray(16)
    SecureRandom().nextBytes(bytes)
    return Base64.encodeToString(bytes, Base64.NO_WRAP or Base64.URL_SAFE or Base64.NO_PADDING)
  }

  override fun isDeviceKeyHardwareBacked(): Boolean = DashOtaDeviceKey.isHardwareBacked()

  companion object {
    const val NAME = NativeDashOtaSpec.NAME
  }
}
