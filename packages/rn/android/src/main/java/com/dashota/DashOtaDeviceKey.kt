package com.dashota

import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyInfo
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.Signature
import java.security.spec.ECGenParameterSpec

/**
 * A hardware-backed EC P-256 device identity in the AndroidKeyStore. The private key never
 * leaves secure hardware, so OTA requests are authenticated by an ECDSA signature the device
 * makes — there is no shared secret to intercept at enrollment (the bootstrap-trust gap that
 * a symmetric HMAC secret would have). The backend stores only the public key.
 */
object DashOtaDeviceKey {
  private const val ALIAS = "dash-ota-device-key"
  private const val PROVIDER = "AndroidKeyStore"

  private fun generate(strongBox: Boolean) {
    val kpg = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, PROVIDER)
    val builder = KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_SIGN)
      .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
      .setDigests(KeyProperties.DIGEST_SHA256)
    if (strongBox && Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) builder.setIsStrongBoxBacked(true)
    kpg.initialize(builder.build())
    kpg.generateKeyPair()
  }

  private fun entry(): KeyStore.PrivateKeyEntry {
    val ks = KeyStore.getInstance(PROVIDER).apply { load(null) }
    if (!ks.containsAlias(ALIAS)) {
      // Prefer the StrongBox secure element; fall back to the TEE-backed keystore where StrongBox
      // isn't present (most devices). Either way the private key stays in secure hardware.
      try {
        generate(strongBox = true)
      } catch (_: Exception) {
        if (ks.containsAlias(ALIAS)) ks.deleteEntry(ALIAS)
        generate(strongBox = false)
      }
    }
    return ks.getEntry(ALIAS, null) as KeyStore.PrivateKeyEntry
  }

  /** Whether the device key resides in secure hardware (StrongBox / TEE), reported to the backend. */
  fun isHardwareBacked(): Boolean =
    try {
      val priv = entry().privateKey
      val factory = KeyFactory.getInstance(priv.algorithm, PROVIDER)
      val info = factory.getKeySpec(priv, KeyInfo::class.java) as KeyInfo
      @Suppress("DEPRECATION")
      info.isInsideSecureHardware
    } catch (_: Exception) {
      false
    }

  /** X.509 SPKI DER public key, base64 (what the backend stores + verifies against). */
  fun publicKeyB64(): String = Base64.encodeToString(entry().certificate.publicKey.encoded, Base64.NO_WRAP)

  /** ECDSA-P256-SHA256 DER signature, base64. */
  fun signB64(message: ByteArray): String {
    val signer = Signature.getInstance("SHA256withECDSA")
    signer.initSign(entry().privateKey)
    signer.update(message)
    return Base64.encodeToString(signer.sign(), Base64.NO_WRAP)
  }
}
