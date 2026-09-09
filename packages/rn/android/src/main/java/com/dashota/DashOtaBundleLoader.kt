package com.dashota

import android.content.Context

/**
 * The early bundle-resolution hook. The host app calls this from
 * `ReactNativeHost.getJSBundleFile()` so the active OTA bundle (or embedded fallback) is
 * chosen **before** React starts. Runs the crash-loop circuit breaker. Never throws — on any
 * error it returns null so the app falls back to the embedded bundle (fail closed).
 *
 * Resolved ONCE per process. React Native re-reads `getJSBundleFile()` on every `reactHost`
 * access (the template's `reactHost` is a computed getter, and `DefaultReactNativeHost.toReactHost`
 * evaluates the path before its own cache check), so a single launch calls this 5–6 times within
 * ~200 ms. Each un-memoised call spends a boot attempt; the third trips the crash-loop breaker,
 * which disables the bundle and `gc()`s its directory while the already-mmapped bundle keeps
 * running — every `require()`d image then 404s (ENOENT) and the update reverts on the next launch.
 *
 * Usage in the host `MainApplication.kt`:
 * ```
 * override fun getJSBundleFile(): String? =
 *   DashOtaBundleLoader.getBundleFile(applicationContext)
 * ```
 */
object DashOtaBundleLoader {
  @Volatile private var resolved: String? = null
  @Volatile private var resolvedOnce = false

  @JvmStatic
  fun getBundleFile(context: Context): String? = synchronized(this) {
    if (!resolvedOnce) {
      resolved = try {
        DashOtaStore.resolveBundleAtLaunch(context)
      } catch (_: Exception) {
        null
      }
      resolvedOnce = true
    }
    resolved
  }
}
