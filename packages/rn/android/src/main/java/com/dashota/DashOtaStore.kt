package com.dashota

import android.content.Context
import android.util.Log
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

  /**
   * Bumped when the on-disk state shape changes in a way older slots cannot survive. State written
   * by a different schema is discarded on load rather than migrated.
   */
  private const val STATE_SCHEMA = 2
  private const val STATE_SCHEMA_KEY = "stateSchema"
  private const val TAG = "DashOta"

  /**
   * One line per cold start saying which bundle was chosen and why. Native on purpose: release
   * builds strip the JS `console.*` trail, and a release APK is not debuggable, so this is the only
   * way to see the launch decision on a real device. Never carries tokens, keys or user data.
   */
  private fun logLaunch(message: String) = Log.w(TAG, "launch: $message")

  @Volatile private var schemaResetLogged = false

  fun baseDir(ctx: Context): File = File(ctx.filesDir, "dash-ota").apply { mkdirs() }
  fun bundlesDir(ctx: Context): File = File(baseDir(ctx), "bundles").apply { mkdirs() }
  fun tmpDir(ctx: Context): File = File(baseDir(ctx), "tmp").apply { mkdirs() }

  /**
   * Where a release is assembled before it becomes a slot. Survives process death on purpose: a
   * download killed half way resumes from what is already verified here instead of starting over.
   */
  fun stagingDir(ctx: Context, bundleId: String): File =
    File(File(baseDir(ctx), "staging"), bundleId).apply { mkdirs() }
  private fun stateFile(ctx: Context): File = File(baseDir(ctx), "state.json")

  /**
   * Per-launch marks live in their own file, NOT in `state.json`. They are written from the main
   * thread by the Activity lifecycle callbacks, and a read-modify-write of the whole state from
   * there can lose a concurrent `markHealthy()` on the JS thread.
   */
  private fun launchFile(ctx: Context): File = File(baseDir(ctx), "launch.json")
  private val launchLock = Any()

  fun loadState(ctx: Context): JSONObject {
    val f = stateFile(ctx)
    if (!f.exists()) return freshState()
    val parsed = try {
      JSONObject(f.readText())
    } catch (_: Exception) {
      // Corrupt state.json (torn write / disk pressure). Treat as fresh — the app keeps booting the
      // embedded bundle and the next check re-stages — instead of throwing on every read, which
      // silently disables OTA on this install forever. Delete so later writes start clean.
      // (iOS already behaves this way via `try?` in DashOtaStore.swift.)
      f.delete()
      return freshState()
    }
    // Slots written before schema 2 were staged by a loader that spent a boot attempt on every host
    // read of the bundle path (RN reads it 5-6x per launch), so the breaker disabled them on their
    // very first boot and deleted the slot dir under the running bundle. Discard, don't migrate:
    // the embedded bundle runs and the next check re-downloads.
    if (parsed.optInt(STATE_SCHEMA_KEY, 1) != STATE_SCHEMA) {
      if (!schemaResetLogged) {
        schemaResetLogged = true
        logLaunch("state schema is not $STATE_SCHEMA — discarding it and starting clean")
      }
      return freshState()
    }
    return parsed
  }

  private fun freshState(): JSONObject = JSONObject().put(STATE_SCHEMA_KEY, STATE_SCHEMA)

  fun saveState(ctx: Context, state: JSONObject) {
    state.put(STATE_SCHEMA_KEY, STATE_SCHEMA)
    val tmp = File(baseDir(ctx), "state.json.tmp")
    tmp.writeText(state.toString())
    if (!tmp.renameTo(stateFile(ctx))) {
      stateFile(ctx).writeText(state.toString())
      tmp.delete()
    }
  }

  /**
   * JS initialised the TurboModule in this process, so the running bundle reached its runtime.
   * Half of the crash-loop forgiveness rule — see [resolveBundleAtLaunch].
   */
  fun markBeacon(ctx: Context) = markLaunch(ctx, "beaconAt")

  /**
   * The foreground was taken from us (Activity paused). A crash never gets to write this, which is
   * what separates "the user swiped the app away" from "the bundle died".
   */
  fun markPaused(ctx: Context) = markLaunch(ctx, "pausedAt")

  /**
   * The app came back to the foreground, so whatever paused it was an interruption, not the user
   * leaving. Without this a bundle that pauses, resumes and *then* crashes would be forgiven; it
   * also discards the transient resign-active iOS raises for a banner or an incoming call.
   */
  fun clearPaused(ctx: Context) {
    synchronized(launchLock) {
      val marks = readLaunchMarks(ctx)
      if (!marks.has("pausedAt")) return
      marks.remove("pausedAt")
      writeLaunchMarks(ctx, marks)
    }
  }

  /** One-shot per process per key; cheap enough to write through to disk immediately. */
  private fun markLaunch(ctx: Context, key: String) {
    synchronized(launchLock) {
      val marks = readLaunchMarks(ctx)
      if (marks.has(key)) return
      marks.put(key, System.currentTimeMillis())
      writeLaunchMarks(ctx, marks)
    }
  }

  /** Read the marks the PREVIOUS process left, and reset them for this one. */
  private fun consumeLaunchMarks(ctx: Context): JSONObject = synchronized(launchLock) {
    val marks = readLaunchMarks(ctx)
    launchFile(ctx).delete()
    marks
  }

  /** Unreadable marks mean "no marks", which counts the launch rather than forgiving it. */
  private fun readLaunchMarks(ctx: Context): JSONObject {
    val f = launchFile(ctx)
    if (!f.exists()) return JSONObject()
    return try {
      JSONObject(f.readText())
    } catch (_: Exception) {
      JSONObject()
    }
  }

  private fun writeLaunchMarks(ctx: Context, marks: JSONObject) {
    try {
      launchFile(ctx).writeText(marks.toString())
    } catch (_: Exception) {
      // Losing a mark only costs a refund; never let it break a lifecycle callback.
    }
  }

  private fun slot(state: JSONObject, key: String): JSONObject? =
    if (state.has(key) && !state.isNull(key)) state.getJSONObject(key) else null

  fun currentBundleVersion(ctx: Context): Int = slot(loadState(ctx), "current")?.optInt("version", 0) ?: 0

  /** Write verified files to a fresh slot dir and record it as `staged`. */
  /**
   * Promote a fully-assembled staging directory into a real slot, atomically.
   *
   * The rename is the commit point: before it there is no slot, after it there is a complete one.
   * A kill in between leaves the staging dir for the next attempt, never a half-written slot.
   *
   * @param files path → plaintext SHA-256 for every file, recorded so the NEXT update can tell
   *   what this device already holds and download only what changed.
   */
  fun commitStaged(
    ctx: Context,
    bundleId: String,
    version: Int,
    runtimeVersion: String,
    bundleSha256: String,
    files: Map<String, String>,
  ) {
    val staging = stagingDir(ctx, bundleId)

    // Refuse to publish a slot that does not contain everything the manifest promised. Without
    // this the state file can advertise a file the directory does not have, the bundle boots, and
    // the missing asset shows up as a blank image at runtime with nothing in any log — which is
    // precisely the 2026-09-08 incident's symptom arriving by a different route.
    val missing = files.keys.filter { path ->
      val f = File(staging, path)
      !f.exists() || f.length() == 0L
    }
    if (missing.isNotEmpty()) {
      staging.deleteRecursively()
      throw IllegalStateException("staged bundle $bundleId is missing ${missing.size} file(s): ${missing.take(5)}")
    }

    val dir = File(bundlesDir(ctx), bundleId)
    if (dir.exists()) dir.deleteRecursively()
    if (!staging.renameTo(dir)) {
      // Across-filesystem rename can fail; fall back to a copy, then drop the staging copy.
      staging.copyRecursively(dir, overwrite = true)
      staging.deleteRecursively()
    }

    val fileMap = JSONObject()
    for ((path, sha) in files) fileMap.put(path, sha)
    val state = loadState(ctx)
    // `nativeBuild` stamps the binary this bundle was staged against — see `isCompatible`.
    state.put(
      "staged",
      JSONObject()
        .put("bundleId", bundleId)
        .put("version", version)
        .put("runtimeVersion", runtimeVersion)
        .put("nativeBuild", DashOtaConfig.nativeBuild(ctx))
        .put("bundleSha256", bundleSha256)
        .put("files", fileMap)
        .put("dir", dir.absolutePath)
    )
    saveState(ctx, state)
  }

  /**
   * Everything this device already holds, as plaintext SHA-256 → an existing file.
   *
   * This is what makes an update small: a file whose hash is already here is linked from the old
   * slot instead of downloaded. Drawn from `current` and `lastKnownGood`, the only two slots GC
   * guarantees to keep.
   */
  fun haveFiles(ctx: Context): Map<String, File> {
    val out = HashMap<String, File>()
    val state = loadState(ctx)
    for (key in listOf("current", "lastKnownGood")) {
      val slot = slot(state, key) ?: continue
      val bundleId = slot.optString("bundleId")
      if (bundleId.isEmpty()) continue
      val dir = File(bundlesDir(ctx), bundleId)
      val files = slot.optJSONObject("files") ?: continue
      for (path in files.keys()) {
        val sha = files.optString(path)
        val file = File(dir, path)
        if (sha.isNotEmpty() && file.exists()) out.putIfAbsent(sha, file)
      }
    }
    return out
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
  }

  /** Manual revert to last-known-good (or embedded if none). */
  fun rollback(ctx: Context): Boolean {
    val state = loadState(ctx)
    state.put("current", slot(state, "lastKnownGood") ?: JSONObject.NULL)
    state.put("trial", false)
    state.put("bootAttempts", 0)
    state.put("pending", JSONObject.NULL)
    saveState(ctx, state)
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
    if (userReload) state.remove("userReload")

    // Marks left behind by the PREVIOUS process. Reaching JS and then being paused is what a user
    // swiping the app away looks like; a crash cannot produce both, in either order, because the
    // pause callback never runs. So that launch is refunded below instead of counting as a crash.
    val prev = consumeLaunchMarks(ctx)
    val forgiven = prev.has("beaconAt") && prev.has("pausedAt")

    // The only safe moment to sweep slots, and therefore the only place gc is called.
    //
    // Nothing is mapped yet this process and no download can be in flight, because JS has not
    // started. `markHealthy`, `rollback` and the incompatible-slot drop used to call it too, from
    // the JS thread, at arbitrary times — and gc deletes any staging directory it does not
    // recognise. A download in progress has not written `staged` yet, so its directory was not
    // recognised: marking healthy while an update was downloading silently deleted the files that
    // had already been assembled. The update then committed with the missing files still listed in
    // the state, and every one of them rendered blank — the 2026-09-08 symptom, reached by a
    // second route. Observed on an emulator: the example app marks healthy 1.5s after mount, and
    // the two files reused before that instant were gone by commit time.
    gc(ctx, state)

    slot(state, "pending")?.let { pending ->
      // Apply the pending bundle on trial.
      state.put("current", pending)
      state.put("pending", JSONObject.NULL)
      state.put("trial", true)
      state.put("bootAttempts", 1)
      // Report the apply exactly once. Only this launch knows a pending bundle became current;
      // by the next one it is indistinguishable from a bundle that has been running for days.
      state.put("appliedToReport", pending.optString("bundleId"))
      saveState(ctx, state)
      logLaunch("applying pending ${pending.optString("bundleId")} on trial (attempt 1/$MAX_BOOT_ATTEMPTS)")
      return bundlePath(ctx, pending)
    }

    val current = slot(state, "current") ?: run {
      saveState(ctx, state)
      logLaunch("no stored bundle — using the embedded one")
      return null
    }
    if (state.optBoolean("trial", false)) {
      var attempts = state.optInt("bootAttempts", 0)
      if (forgiven && attempts > 0) attempts -= 1
      if (attempts >= MAX_BOOT_ATTEMPTS) {
        // Crash loop: the trial bundle never marked healthy → DISABLE it (never re-stage) and
        // revert to last-known-good; remember it so the recovered app can report the failure.
        val failedId = current.optString("bundleId")
        val disabled = state.optJSONArray("disabledBundles") ?: JSONArray()
        if (failedId.isNotEmpty() && !jsonArrayContains(disabled, failedId)) disabled.put(failedId)
        state.put("disabledBundles", disabled)
        state.put("failedToReport", failedId)
        // The fallback goes on trial too, with nothing behind it but the embedded bundle: if it
        // also loops (state the failed bundle left behind, say), the next revert lands on embedded.
        val lkg = slot(state, "lastKnownGood")
        state.put("current", lkg ?: JSONObject.NULL)
        state.put("lastKnownGood", JSONObject.NULL)
        state.put("trial", lkg != null)
        state.put("bootAttempts", if (lkg != null) 1 else 0)
        saveState(ctx, state)
        logLaunch("crash loop: disabling $failedId, reverting to ${lkg?.optString("bundleId")?.let { "$it on trial" } ?: "the embedded bundle"}")
        return lkg?.let { bundlePath(ctx, it) }
      }
      if (!userReload) attempts += 1
      state.put("bootAttempts", attempts)
      saveState(ctx, state)
      logLaunch(
        "${current.optString("bundleId")} on trial, attempt $attempts/$MAX_BOOT_ATTEMPTS" +
          (if (forgiven) " (previous launch refunded: reached JS then paused)" else "") +
          (if (userReload) " (user reload, not counted)" else "")
      )
      return bundlePath(ctx, current)
    }
    saveState(ctx, state)
    logLaunch("${current.optString("bundleId")} (healthy)")
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
      .put("bundleSha256", current?.optString("bundleSha256") ?: "")
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

  /** Return + clear the bundleId applied on this launch (report once). */
  fun consumeAppliedReport(ctx: Context): String {
    val state = loadState(ctx)
    val applied = state.optString("appliedToReport", "")
    if (applied.isNotEmpty()) {
      state.remove("appliedToReport")
      saveState(ctx, state)
    }
    return applied
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

  /**
   * Delete slot dirs no state key still references. Keyed by bundleId (dir names), not stored
   * absolute paths — parity with iOS.
   *
   * The keep-set covers `pending` and `staged` too: keeping only current + last-known-good meant a
   * bundle downloaded inside the health window was deleted by the `markHealthy` sweep before it
   * could ever be applied.
   *
   * NEVER call this from the crash-loop branch. The bundle being demoted there is memory-mapped by
   * the process running it, so deleting its dir leaves the JS running with every require()d asset
   * gone (ENOENT) — the 2026-09-08 production incident.
   */
  private fun gc(ctx: Context, state: JSONObject) {
    val keep = listOf("current", "lastKnownGood", "pending", "staged")
      .mapNotNull { key -> slot(state, key)?.optString("bundleId")?.takeIf { it.isNotEmpty() } }
      .toSet()
    bundlesDir(ctx).listFiles()?.forEach { dir ->
      if (dir.name !in keep) dir.deleteRecursively()
    }
    // Staging for anything no longer referenced is dead weight; the download will restart cleanly.
    File(baseDir(ctx), "staging").listFiles()?.forEach { dir ->
      if (dir.name !in keep && slot(state, "staged")?.optString("bundleId") != dir.name) dir.deleteRecursively()
    }
  }
}
