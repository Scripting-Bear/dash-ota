package com.dashota

import android.content.Context

/**
 * The early bundle-resolution hook. The host app calls this from
 * `ReactNativeHost.getJSBundleFile()` so the active OTA bundle (or embedded fallback) is
 * chosen **before** React starts. Runs the crash-loop circuit breaker. Never throws — on any
 * error it returns null so the app falls back to the embedded bundle (fail closed).
 *
 * Usage in the host `MainApplication.kt`:
 * ```
 * override fun getJSBundleFile(): String? =
 *   DashOtaBundleLoader.getBundleFile(applicationContext)
 * ```
 */
object DashOtaBundleLoader {
  @JvmStatic
  fun getBundleFile(context: Context): String? = try {
    DashOtaStore.resolveBundleAtLaunch(context)
  } catch (_: Exception) {
    null
  }
}
