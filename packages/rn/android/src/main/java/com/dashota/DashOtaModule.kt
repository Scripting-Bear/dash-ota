package com.dashota

import android.app.Activity
import android.app.Application
import android.content.Intent
import android.system.Os
import android.os.Bundle
import android.util.Base64
import android.util.Log
import com.facebook.react.ReactApplication
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.modules.core.DeviceEventManagerModule
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

  /**
   * Called by React Native when JS first touches this module. Two jobs, both feeding the crash-loop
   * breaker in [DashOtaStore.resolveBundleAtLaunch]:
   *
   *  - reaching here at all proves the running bundle got as far as its JS runtime (the *beacon*);
   *  - registering the pause callback lets the store tell a user-driven exit from a crash.
   *
   * Without the pair, a user force-killing the app twice inside the health window walks a perfectly
   * healthy bundle into the breaker and gets it blocklisted.
   */
  override fun initialize() {
    super.initialize()
    DashOtaStore.markBeacon(reactContext)
    val app = reactContext.applicationContext as? Application ?: return
    synchronized(DashOtaModule::class.java) {
      if (lifecycleRegistered) return
      lifecycleRegistered = true
    }
    app.registerActivityLifecycleCallbacks(object : Application.ActivityLifecycleCallbacks {
      override fun onActivityPaused(activity: Activity) = DashOtaStore.markPaused(reactContext)
      override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) = Unit
      override fun onActivityStarted(activity: Activity) = Unit
      override fun onActivityResumed(activity: Activity) = DashOtaStore.clearPaused(reactContext)
      override fun onActivityStopped(activity: Activity) = Unit
      override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) = Unit
      override fun onActivityDestroyed(activity: Activity) = Unit
    })
  }

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
      // The server uses this to tell which bundle is running, so a delta can be built against it.
      map.putString("bundleSha256", meta.optString("bundleSha256", ""))
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
    blobBaseUrl: String,
    downloadToken: String,
    manifestJson: String,
    signatureB64: String,
    promise: Promise,
  ) {
    Thread {
      try {
        // 1. Ed25519-verify the canonical manifest bytes against the embedded key ring. Nothing
        //    below this line trusts a single field until this passes.
        val keys = getPublicKeysB64().split(",").map { it.trim() }.filter { it.isNotEmpty() }
        val manifestBytes = manifestJson.toByteArray(Charsets.UTF_8)
        if (!DashOtaCrypto.ed25519VerifyAny(keys, manifestBytes, DashOtaCrypto.b64(signatureB64))) {
          promise.reject("sig_invalid", "manifest signature did not verify")
          return@Thread
        }
        val manifest = JSONObject(manifestJson)

        // 2. Gates, cheapest first, all before any I/O.
        if (manifest.optInt("schema") != 2) {
          promise.reject("sig_invalid", "unsupported manifest schema ${manifest.optInt("schema")}")
          return@Thread
        }
        if (manifest.optString("appId") != reactContext.packageName) {
          promise.reject("app_mismatch", "manifest is for a different app")
          return@Thread
        }
        if (manifest.getString("runtimeVersion") != getRuntimeVersion()) {
          promise.reject("runtime_mismatch", "bundle runtimeVersion does not match this binary")
          return@Thread
        }
        val version = manifest.getInt("bundleVersion")
        if (version <= DashOtaStore.currentBundleVersion(reactContext)) {
          promise.reject("downgrade", "bundleVersion is not newer than current")
          return@Thread
        }
        val bundleId = manifest.getString("bundleId")
        if (DashOtaStore.isDisabled(reactContext, bundleId)) {
          promise.reject("bundle_disabled", "bundle was disabled after a crash loop")
          return@Thread
        }

        val encryption = manifest.getJSONObject("encryption")
        val contentKey =
          if (encryption.getString("mode") == "aes-256-gcm") DashOtaCrypto.b64(encryption.getString("contentKeyB64"))
          else null

        val entries = manifest.getJSONArray("files")
        // Every path is checked before anything is written: a valid signature over "../../x" is
        // still a valid signature.
        for (i in 0 until entries.length()) {
          val path = entries.getJSONObject(i).getString("path")
          val bad = invalidPath(path)
          if (bad != null) {
            promise.reject("path_invalid", "manifest path $path $bad")
            return@Thread
          }
        }

        val staging = DashOtaStore.stagingDir(reactContext, bundleId)
        val have = DashOtaStore.haveFiles(reactContext)
        val fileMap = HashMap<String, String>()
        var bundleSha = ""

        var bytesDone = 0L
        var bytesTotal = 0L
        // Set false the first time the platform refuses a hard link; see the reuse branch below.
        var canHardLink = true
        for (i in 0 until entries.length()) {
          val e = entries.getJSONObject(i)
          if (!have.containsKey(e.getString("sha256"))) bytesTotal += e.getJSONObject("blob").getLong("size")
        }

        for (i in 0 until entries.length()) {
          val entry = entries.getJSONObject(i)
          val path = entry.getString("path")
          val plainSha = entry.getString("sha256")
          val size = entry.getInt("size")
          if (entry.optString("role") == "bundle") bundleSha = plainSha
          fileMap[path] = plainSha

          val out = File(staging, path)
          out.parentFile?.mkdirs()

          // Already assembled by an earlier, interrupted attempt.
          if (out.exists() && out.length() == size.toLong() && DashOtaCrypto.sha256HexOfFile(out) == plainSha) continue

          val reusable = have[plainSha]
          if (reusable != null) {
            // The file is already on this device, so reuse the bytes instead of fetching them.
            //
            // A hard link would make that free, and it is tried once per download — but SELinux
            // denies `link` to untrusted_app on app_data_file, so on a normal Android build it
            // always fails with EACCES and the copy below is the real path. Measured on an
            // API 34 emulator: `avc: denied { link } ... tclass=file`. Probing once rather than
            // per file keeps a 120-asset reuse from emitting 120 identical failures.
            out.delete()
            if (canHardLink) {
              try {
                Os.link(reusable.absolutePath, out.absolutePath)
              } catch (e: Exception) {
                canHardLink = false
                Log.w(TAG, "reuse: hard links unavailable (${e.javaClass.simpleName}: ${e.message}); copying instead")
              }
            }
            if (!out.exists()) reusable.copyTo(out, overwrite = true)
            if (out.length() != size.toLong() || DashOtaCrypto.sha256HexOfFile(out) != plainSha) {
              out.delete()
              promise.reject("file_hash_mismatch", "reused file $path did not verify")
              return@Thread
            }
            continue
          }

          val blob = entry.getJSONObject("blob")
          val blobSha = blob.getString("sha256")
          val blobSize = blob.getLong("size")
          val part = File(DashOtaStore.tmpDir(reactContext), "$blobSha.part")

          downloadBlob("$blobBaseUrl/$blobSha", downloadToken, part, blobSize)
          if (DashOtaCrypto.sha256HexOfFile(part) != blobSha) {
            part.delete()
            promise.reject("blob_hash_mismatch", "blob $blobSha did not verify")
            return@Thread
          }

          // Verified bytes only from here: decrypt, then decompress, then check the plaintext.
          // Every step is file-to-file. Holding a decompressed Hermes bundle in a ByteArray costs
          // tens of megabytes on a device that may already be under memory pressure, and it is the
          // largest single allocation the update path would make.
          val tmpOut = File(staging, "$path.part")
          tmpOut.parentFile?.mkdirs()
          var sealed = part
          if (contentKey != null) {
            val plainFile = File(DashOtaStore.tmpDir(reactContext), "$blobSha.dec")
            try {
              DashOtaCrypto.aesGcmDecryptToFile(
                contentKey,
                DashOtaCrypto.b64(blob.getString("ivB64")),
                part,
                DashOtaCrypto.b64(blob.getString("tagB64")),
                // AAD binds the ciphertext to the plaintext it claims to be, and deliberately not
                // to the release: one blob is shared by every release containing that file.
                plainSha.toByteArray(Charsets.UTF_8),
                plainFile,
              )
            } catch (e: Exception) {
              part.delete()
              promise.reject("decrypt_failed", "blob $blobSha did not authenticate: ${e.message}")
              return@Thread
            }
            part.delete()
            sealed = plainFile
          }

          val writtenSha =
            try {
              if (blob.getString("compression") == "zstd") {
                DashOtaCrypto.zstdDecompressToFile(sealed, tmpOut, size)
              } else {
                if (!sealed.renameTo(tmpOut)) sealed.copyTo(tmpOut, overwrite = true)
                DashOtaCrypto.sha256HexOfFile(tmpOut)
              }
            } catch (e: Exception) {
              sealed.delete()
              tmpOut.delete()
              promise.reject("decompress_failed", "blob $blobSha could not be unpacked: ${e.message}")
              return@Thread
            }
          sealed.delete()
          if (tmpOut.length() != size.toLong() || writtenSha != plainSha) {
            tmpOut.delete()
            promise.reject("file_hash_mismatch", "file $path did not verify")
            return@Thread
          }

          // Rename into place only now, so a kill never leaves a short file that a later resume
          // would mistake for a complete one.
          if (!tmpOut.renameTo(out)) {
            tmpOut.copyTo(out, overwrite = true)
            tmpOut.delete()
          }

          bytesDone += blobSize
          emitProgress(bundleId, bytesDone, bytesTotal, i + 1, entries.length())
        }

        DashOtaStore.commitStaged(reactContext, bundleId, version, manifest.getString("runtimeVersion"), bundleSha, fileMap)
        val map = Arguments.createMap()
        map.putString("bundleId", bundleId)
        map.putDouble("bundleVersion", version.toDouble())
        promise.resolve(map)
      } catch (e: Exception) {
        promise.reject(classifyError(e), e.message ?: "download failed")
      }
    }.start()
  }

  /** Map an exception onto the typed codes the JS layer surfaces as `ota.error.code`. */
  private fun classifyError(e: Exception): String {
    val msg = e.message ?: ""
    return when {
      e is javax.crypto.AEADBadTagException -> "blob_hash_mismatch"
      e is java.io.IOException && msg.contains("space", ignoreCase = true) -> "disk_full"
      e is java.io.IOException -> "network"
      else -> "download_failed"
    }
  }

  /**
   * Path rules, mirroring the publisher's. Enforced here too because the manifest is only
   * trustworthy about *content*: a signature says nothing about whether a path is safe to write.
   */
  private fun invalidPath(path: String): String? {
    if (path.isEmpty()) return "is empty"
    if (path.toByteArray(Charsets.UTF_8).size > 512) return "is too long"
    if (path.contains('\u0000')) return "contains a NUL byte"
    if (path.contains('\\')) return "contains a backslash"
    if (path.startsWith("/")) return "is absolute"
    for (segment in path.split("/")) {
      if (segment.isEmpty()) return "contains an empty segment"
      if (segment == "." || segment == "..") return "contains a $segment segment"
    }
    return null
  }

  private fun emitProgress(bundleId: String, bytesDone: Long, bytesTotal: Long, filesDone: Int, filesTotal: Int) {
    try {
      val payload = Arguments.createMap()
      payload.putString("bundleId", bundleId)
      payload.putDouble("bytesDone", bytesDone.toDouble())
      payload.putDouble("bytesTotal", bytesTotal.toDouble())
      payload.putInt("filesDone", filesDone)
      payload.putInt("filesTotal", filesTotal)
      reactContext
        .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
        .emit("onDashOtaProgress", payload)
    } catch (_: Exception) {
      // Progress is cosmetic; never let it fail a download.
    }
  }

  override fun addListener(eventName: String) = Unit

  override fun removeListeners(count: Double) = Unit

  /**
   * Fetch one blob, resuming from whatever a previous attempt already wrote.
   *
   * Resume is the whole point of ranging here: the bytecode blob is several megabytes and a
   * dropped connection on a train should cost the remainder, not the lot.
   */
  private fun downloadBlob(urlStr: String, token: String, dest: File, expectedSize: Long) {
    var have = if (dest.exists()) dest.length() else 0L
    if (have > expectedSize) {
      dest.delete()
      have = 0L
    }
    if (have == expectedSize) return

    val conn = URL(urlStr).openConnection() as HttpURLConnection
    conn.requestMethod = "GET"
    conn.setRequestProperty("x-ota-download-token", token)
    if (have > 0L) conn.setRequestProperty("Range", "bytes=$have-")
    conn.connectTimeout = 15000
    conn.readTimeout = 30000
    try {
      // Optional certificate pinning (off unless ota_tls_pins is configured). Verify before any body.
      verifyPins(conn)
      val code = conn.responseCode
      // A server that ignores the Range header answers 200 with the whole object; start over
      // rather than appending it to what we already had.
      val append = code == 206
      if (code != 200 && code != 206) throw RuntimeException("download HTTP $code")
      if (!append) have = 0L

      val remaining = expectedSize - have
      val declared = conn.contentLengthLong
      if (declared >= 0L && declared != remaining) {
        throw RuntimeException("Content-Length $declared != expected $remaining")
      }

      conn.inputStream.use { input ->
        java.io.FileOutputStream(dest, append).use { out ->
          val buf = ByteArray(64 * 1024)
          var total = have
          while (true) {
            val n = input.read(buf)
            if (n < 0) break
            total += n
            if (total > expectedSize) throw RuntimeException("download exceeded the signed blob size")
            out.write(buf, 0, n)
          }
          if (total != expectedSize) throw RuntimeException("download truncated: $total != $expectedSize")
        }
      }
    } finally {
      conn.disconnect()
    }
  }

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

  override fun consumeAppliedReport(): String = DashOtaStore.consumeAppliedReport(reactContext)

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
    // Relaunch the app in a FRESH PROCESS. Nothing lighter works on Android: `ReactHost.reload()`
    // rebuilds the React instance but replays the JSBundleLoader that `getDefaultReactHost` built
    // once at startup, so the pending bundle is recorded as current while the runtime keeps running
    // the OLD code — the update only appears after the user kills the app themselves. (iOS differs:
    // RCTHost re-invokes its bundleURLProvider on reload, so there a reload is enough.)
    // `Activity.recreate()` is weaker still — it rebuilds the Activity and keeps the whole host.
    try {
      val activity = reactContext.currentActivity ?: return
      // Flag the coming launch as user-initiated so the crash-loop breaker doesn't charge it a boot
      // attempt (see DashOtaStore.markUserReload).
      DashOtaStore.markUserReload(reactContext)
      val relaunch =
        reactContext.packageManager.getLaunchIntentForPackage(reactContext.packageName)?.apply {
          addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
        }
      if (relaunch == null) {
        // No launcher intent to come back to — fall back to a reload rather than killing the app
        // with no way back. The bundle then applies on the next real cold start.
        (reactContext.applicationContext as? ReactApplication)?.reactHost?.reload("dash-ota: applying update")
        return
      }
      activity.runOnUiThread {
        try {
          Log.w(NAME, "restart: relaunching for OTA apply")
          reactContext.startActivity(relaunch)
          activity.finish()
          // The replacement Activity is already queued, so ending this process is what forces a fresh
          // one — and with it a fresh getJSBundleFile() that resolves the newly applied bundle.
          Log.w(NAME, "restart: exiting process")
          Runtime.getRuntime().exit(0)
        } catch (e: Exception) {
          Log.w(NAME, "restart: relaunch failed (${e.message}) — falling back to reload")
          (reactContext.applicationContext as? ReactApplication)?.reactHost?.reload("dash-ota: applying update")
        }
      }
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

    /** Shared with DashOtaStore so one `adb logcat -s DashOta` shows the whole update path. */
    private const val TAG = "DashOta"

    /** Process-wide: the module can be recreated across reloads, the callback must not stack up. */
    @Volatile
    private var lifecycleRegistered = false
  }
}
