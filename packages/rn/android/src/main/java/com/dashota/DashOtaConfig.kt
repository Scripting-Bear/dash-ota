package com.dashota

import android.content.Context

/**
 * Reads the per-flavour OTA config that the host app embeds at build time as Android string /
 * integer resources (via `resValue` in the example app's product flavors — the same pattern
 * go-trade uses for Stallion). Resolving by name means the package needs no compile-time
 * dependency on the host's `R`. The embedded public key + runtimeVersion are security-relevant
 * and therefore native, not JS.
 */
object DashOtaConfig {
  private fun str(ctx: Context, name: String, def: String): String {
    val id = ctx.resources.getIdentifier(name, "string", ctx.packageName)
    return if (id != 0) ctx.getString(id) else def
  }

  fun channel(ctx: Context): String = str(ctx, "ota_channel", "dev")
  fun serverUrl(ctx: Context): String = str(ctx, "ota_server_url", "")
  /** comma-separated raw base64 Ed25519 public keys (a key ring for rotation). */
  fun publicKeysB64(ctx: Context): String = str(ctx, "ota_public_keys", "")
  fun runtimeVersion(ctx: Context): String = str(ctx, "ota_runtime_version", "embedded")

  fun nativeBuild(ctx: Context): Int {
    val id = ctx.resources.getIdentifier("ota_native_build", "integer", ctx.packageName)
    return if (id != 0) ctx.resources.getInteger(id) else 0
  }
}
