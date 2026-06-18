package com.dashota

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

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
      map.putBoolean("otaDisabled", false)
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

        // 4. download ciphertext to a temp file.
        tmp = File(DashOtaStore.tmpDir(reactContext), "$bundleId.bin")
        downloadTo(downloadUrl, downloadToken, tmp)
        val ciphertext = tmp.readBytes()

        // 5. ciphertext hash.
        val enc = manifest.getJSONObject("encryption")
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

  private fun downloadTo(urlStr: String, token: String, dest: File) {
    val conn = URL(urlStr).openConnection() as HttpURLConnection
    conn.requestMethod = "GET"
    conn.setRequestProperty("x-ota-download-token", token)
    conn.connectTimeout = 15000
    conn.readTimeout = 30000
    try {
      if (conn.responseCode != 200) throw RuntimeException("download HTTP ${conn.responseCode}")
      conn.inputStream.use { input -> dest.outputStream().use { out -> input.copyTo(out) } }
    } finally {
      conn.disconnect()
    }
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

  companion object {
    const val NAME = NativeDashOtaSpec.NAME
  }
}
