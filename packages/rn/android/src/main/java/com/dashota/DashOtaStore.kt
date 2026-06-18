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
    return if (f.exists()) JSONObject(f.readText()) else JSONObject()
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
    state.put(
      "staged",
      JSONObject().put("bundleId", bundleId).put("version", version).put("runtimeVersion", runtimeVersion).put("dir", dir.absolutePath)
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
   * Resolve which bundle to load at launch, applying pending and the crash-loop circuit
   * breaker. Returns the bundle file path, or null to fall back to the embedded bundle.
   */
  fun resolveBundleAtLaunch(ctx: Context): String? {
    val state = loadState(ctx)

    slot(state, "pending")?.let { pending ->
      // Apply the pending bundle on trial.
      state.put("current", pending)
      state.put("pending", JSONObject.NULL)
      state.put("trial", true)
      state.put("bootAttempts", 1)
      saveState(ctx, state)
      return bundlePath(pending)
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
        return lkg?.let { bundlePath(it) }
      }
      state.put("bootAttempts", attempts + 1)
      saveState(ctx, state)
      return bundlePath(current)
    }
    return bundlePath(current)
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

  private fun bundlePath(slot: JSONObject): String = File(slot.getString("dir"), BUNDLE_FILE).absolutePath

  private fun gc(ctx: Context) {
    val state = loadState(ctx)
    val keep = listOfNotNull(
      slot(state, "current")?.optString("dir"),
      slot(state, "lastKnownGood")?.optString("dir")
    ).toSet()
    bundlesDir(ctx).listFiles()?.forEach { dir ->
      if (dir.absolutePath !in keep) dir.deleteRecursively()
    }
  }
}
