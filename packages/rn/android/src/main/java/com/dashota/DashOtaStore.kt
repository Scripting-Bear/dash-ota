package com.dashota

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * On-disk slot + state manager. Holds the active (`current`), `lastKnownGood`, `staged`, and
 * `pending` bundles plus crash-loop counters, and implements the launch-time apply / revert
 * logic. State writes are crash-safe (temp + rename). GC keeps only current + last-known-good.
 */
object DashOtaStore {
  private const val MAX_BOOT_ATTEMPTS = 2
  private const val BUNDLE_FILE = "index.android.bundle"

  fun baseDir(ctx: Context): File = File(ctx.filesDir, "dash-ota").apply { mkdirs() }
  fun bundlesDir(ctx: Context): File = File(baseDir(ctx), "bundles").apply { mkdirs() }
  fun tmpDir(ctx: Context): File = File(baseDir(ctx), "tmp").apply { mkdirs() }
  private fun stateFile(ctx: Context): File = File(baseDir(ctx), "state.json")

  fun loadState(ctx: Context): JSONObject {
    val f = stateFile(ctx)
    if (!f.exists()) return JSONObject()
    return try {
      JSONObject(f.readText())
    } catch (_: Exception) {
      // Corrupt state.json (torn write / disk pressure). Treat as fresh — the app keeps booting the
      // embedded bundle and the next check re-stages — instead of throwing on every read, which
      // silently disables OTA on this install forever. Delete so later writes start clean.
      // (iOS already behaves this way via `try?` in DashOtaStore.swift.)
      f.delete()
      JSONObject()
    }
  }

  fun saveState(ctx: Context, state: JSONObject) {
    val tmp = File(baseDir(ctx), "state.json.tmp")
    tmp.writeText(state.toString())
    if (!tmp.renameTo(stateFile(ctx))) {
      stateFile(ctx).writeText(state.toString())
      tmp.delete()
    }
  }

  private fun slot(state: JSONObject, key: String): JSONObject? =
    if (state.has(key) && !state.isNull(key)) state.getJSONObject(key) else null

  fun currentBundleVersion(ctx: Context): Int = slot(loadState(ctx), "current")?.optInt("version", 0) ?: 0

  /** Write verified files to a fresh slot dir and record it as `staged`. */
  fun stage(ctx: Context, bundleId: String, version: Int, runtimeVersion: String, files: List<Pair<String, ByteArray>>) {
    val dir = File(bundlesDir(ctx), bundleId)
    if (dir.exists()) dir.deleteRecursively()
    dir.mkdirs()
    for ((path, data) in files) {
      val outFile = File(dir, path)
      outFile.parentFile?.mkdirs()
      outFile.writeBytes(data)
    }
    val state = loadState(ctx)
    // `nativeBuild` stamps the binary this bundle was staged against — see `isCompatible`.
    state.put(
      "staged",
      JSONObject()
        .put("bundleId", bundleId)
        .put("version", version)
        .put("runtimeVersion", runtimeVersion)
        .put("nativeBuild", DashOtaConfig.nativeBuild(ctx))
        .put("dir", dir.absolutePath)
    )
    saveState(ctx, state)
  }

  /** Promote `staged` → `pending` so it applies on next cold start. */
  fun promoteStagedToPending(ctx: Context): Boolean {
    val state = loadState(ctx)
    val staged = slot(state, "staged") ?: return false
    state.put("pending", staged)
    state.put("staged", JSONObject.NULL)
    saveState(ctx, state)
    return true
  }

  /** Confirm the running bundle healthy: promote to last-known-good, clear the trial counter. */
  fun markHealthy(ctx: Context) {
    val state = loadState(ctx)
    val current = slot(state, "current") ?: return
    state.put("lastKnownGood", current)
    state.put("trial", false)
    state.put("bootAttempts", 0)
    saveState(ctx, state)
    gc(ctx)
  }

  /** Manual revert to last-known-good (or embedded if none). */
  fun rollback(ctx: Context): Boolean {
    val state = loadState(ctx)
    state.put("current", slot(state, "lastKnownGood") ?: JSONObject.NULL)
    state.put("trial", false)
    state.put("bootAttempts", 0)
    state.put("pending", JSONObject.NULL)
    saveState(ctx, state)
    gc(ctx)
    return true
  }

  /**
   * Whether a stored slot may still be loaded by THIS binary.
   *
   * A bundle is only valid for the binary it was staged against. Two things invalidate it:
   * `runtimeVersion` (the native contract changed, so the JS may call APIs that no longer exist)
   * and `nativeBuild` (the store shipped a newer build, whose embedded JS is by definition newer
   * than anything staged before it). Without this, the first launch after a store update loads the
   * pre-update bundle over the new binary — silently discarding the JS the update just shipped.
   *
   * Slots written before this field existed have no `nativeBuild`; they count as incompatible so
   * the upgrade resets cleanly rather than trusting an unverifiable slot.
   */
  private fun isCompatible(ctx: Context, slot: JSONObject): Boolean {
    if (slot.optString("runtimeVersion") != DashOtaConfig.runtimeVersion(ctx)) return false
    if (!slot.has("nativeBuild")) return false
    return slot.optInt("nativeBuild", -1) == DashOtaConfig.nativeBuild(ctx)
  }

  /**
   * Drop every slot staged against a different binary so the embedded bundle loads instead.
   * @return true when something was discarded (state already saved).
   */
  private fun dropIncompatibleSlots(ctx: Context, state: JSONObject): Boolean {
    var dropped = false
    for (key in listOf("pending", "staged", "current", "lastKnownGood")) {
      val s = slot(state, key) ?: continue
      if (!isCompatible(ctx, s)) {
        state.put(key, JSONObject.NULL)
        dropped = true
      }
    }
    if (dropped) {
      // The trial counters belong to a bundle that is no longer loadable.
      state.put("trial", false)
      state.put("bootAttempts", 0)
      saveState(ctx, state)
      gc(ctx)
    }
    return dropped
  }

  /**
   * Resolve which bundle to load at launch, applying pending and the crash-loop circuit
   * breaker. Returns the bundle file path, or null to fall back to the embedded bundle.
   */
  fun resolveBundleAtLaunch(ctx: Context): String? {
    val state = loadState(ctx)

    // Before anything else: a binary that changed underneath us (store update / sideload) must not
    // run bundles staged for the previous one.
    dropIncompatibleSlots(ctx, state)

    // A reload the user asked for is not evidence of a crash. Consume the marker and let this launch
    // pass without spending a boot attempt — otherwise impatient tapping on "restart to apply" walks
    // a perfectly healthy bundle into the crash-loop breaker and blocklists it. Genuine cold starts
    // still count, so a bundle that really crashes on boot is still caught.
    val userReload = state.optBoolean("userReload", false)
    if (userReload) {
      state.remove("userReload")
      saveState(ctx, state)
    }

    slot(state, "pending")?.let { pending ->
      // Apply the pending bundle on trial.
      state.put("current", pending)
      state.put("pending", JSONObject.NULL)
      state.put("trial", true)
      state.put("bootAttempts", 1)
      saveState(ctx, state)
      return bundlePath(ctx, pending)
    }

    val current = slot(state, "current") ?: return null
    if (state.optBoolean("trial", false)) {
      val attempts = state.optInt("bootAttempts", 0)
      if (attempts >= MAX_BOOT_ATTEMPTS) {
        // Crash loop: the trial bundle never marked healthy → DISABLE it (never re-stage) and
        // revert to last-known-good; remember it so the recovered app can report the failure.
        val failedId = current.optString("bundleId")
        val disabled = state.optJSONArray("disabledBundles") ?: JSONArray()
        if (failedId.isNotEmpty() && !jsonArrayContains(disabled, failedId)) disabled.put(failedId)
        state.put("disabledBundles", disabled)
        state.put("failedToReport", failedId)
        val lkg = slot(state, "lastKnownGood")
        state.put("current", lkg ?: JSONObject.NULL)
        state.put("trial", false)
        state.put("bootAttempts", 0)
        saveState(ctx, state)
        gc(ctx)
        return lkg?.let { bundlePath(ctx, it) }
      }
      if (!userReload) {
        state.put("bootAttempts", attempts + 1)
        saveState(ctx, state)
      }
      return bundlePath(ctx, current)
    }
    return bundlePath(ctx, current)
  }

  /**
   * Record that the NEXT launch is a deliberate in-process reload (the user tapped "restart to
   * apply"), not a fresh cold start. One-shot: [resolveBundleAtLaunch] consumes it.
   */
  fun markUserReload(ctx: Context) {
    val state = loadState(ctx)
    state.put("userReload", true)
    saveState(ctx, state)
  }

  fun currentMeta(ctx: Context): JSONObject {
    val current = slot(loadState(ctx), "current")
    return JSONObject()
      .put("bundleId", current?.optString("bundleId") ?: "embedded")
      .put("bundleVersion", current?.optInt("version", 0) ?: 0)
      .put("isEmbedded", current == null)
  }

  /** True if a bundle was disabled by the crash-loop breaker. */
  fun isDisabled(ctx: Context, bundleId: String): Boolean {
    val disabled = loadState(ctx).optJSONArray("disabledBundles") ?: return false
    return jsonArrayContains(disabled, bundleId)
  }

  /** Return + clear the bundleId most recently disabled by a crash-loop revert (report once). */
  fun consumeFailedReport(ctx: Context): String {
    val state = loadState(ctx)
    val failed = state.optString("failedToReport", "")
    if (failed.isNotEmpty()) {
      state.remove("failedToReport")
      saveState(ctx, state)
    }
    return failed
  }

  private fun jsonArrayContains(arr: JSONArray, value: String): Boolean {
    for (i in 0 until arr.length()) if (arr.optString(i) == value) return true
    return false
  }

  private fun bundlePath(ctx: Context, slot: JSONObject): String? {
    // Resolve from the runtime bundles dir + bundleId, mirroring iOS: never trust the stored
    // absolute `dir` (stale after any container/path migration), and return null when the bundle
    // file is missing so the loader falls back to the embedded bundle instead of crashing boot.
    val bundleId = slot.optString("bundleId")
    if (bundleId.isEmpty()) return null
    val f = File(File(bundlesDir(ctx), bundleId), BUNDLE_FILE)
    return if (f.exists()) f.absolutePath else null
  }

  private fun gc(ctx: Context) {
    val state = loadState(ctx)
    // Keep by bundleId (dir names), not stored absolute paths — parity with iOS.
    val keep = listOfNotNull(
      slot(state, "current")?.optString("bundleId"),
      slot(state, "lastKnownGood")?.optString("bundleId")
    ).toSet()
    bundlesDir(ctx).listFiles()?.forEach { dir ->
      if (dir.name !in keep) dir.deleteRecursively()
    }
  }
}
