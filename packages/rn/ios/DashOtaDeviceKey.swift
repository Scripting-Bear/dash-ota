import Foundation
import Security

/// Hardware-backed device identity for request authentication. A persistent EC P-256 key pair
/// lives in the Keychain — in the **Secure Enclave** on real hardware (the private key is
/// non-exportable), falling back to a software Keychain key on the Simulator (no Enclave). The
/// private key never leaves the device, so enrollment transmits only the public key: there is
/// no shared secret to intercept.
///
/// Mirrors `DashOtaDeviceKey.kt` (AndroidKeyStore). The public key is exported as **SPKI-DER**
/// (base64) and signatures are **ECDSA-P256-SHA256 in X9.62/DER** — exactly what the backend's
/// `node:crypto` verify path expects.
enum DashOtaDeviceKey {
  private static let tag = "dash-ota-device-key".data(using: .utf8)!
  /// Persisted provenance of the device key: true iff it was created in the Secure Enclave.
  private static let hwFlagKey = "dash-ota-device-key-hw"

  /// Whether the device key is hardware-backed (Secure Enclave). Reported to the backend at
  /// enrollment so a host can gate on genuine hardware. Conservative: keys created before this
  /// flag existed, and the Simulator, report false.
  static func isHardwareBacked() -> Bool {
    _ = try? loadOrCreate() // ensure the key (and its flag) exist
    return UserDefaults.standard.bool(forKey: hwFlagKey)
  }
  /// 26-byte ASN.1 SPKI prefix for an EC P-256 (prime256v1) public key, before the 65-byte point.
  private static let p256SpkiHeader = Data([
    0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01,
    0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00,
  ])

  /// The device public key as base64-encoded SPKI-DER (what `/enroll` registers).
  static func publicKeyB64() -> String {
    guard let priv = try? loadOrCreate(),
          let pub = SecKeyCopyPublicKey(priv),
          let x963 = SecKeyCopyExternalRepresentation(pub, nil) as Data? else {
      return ""
    }
    // CryptoKit/SecKey emit the public key as a raw X9.63 point (0x04‖X‖Y); wrap it in the
    // fixed P-256 SPKI header so it parses as a standard SubjectPublicKeyInfo.
    return (p256SpkiHeader + x963).base64EncodedString()
  }

  /// Sign a UTF-8 message with the device key (ECDSA-P256-SHA256, DER) → base64. "" on failure.
  static func signB64(_ message: String) -> String {
    guard let priv = try? loadOrCreate() else { return "" }
    var error: Unmanaged<CFError>?
    guard let sig = SecKeyCreateSignature(
      priv,
      .ecdsaSignatureMessageX962SHA256,
      Data(message.utf8) as CFData,
      &error
    ) as Data? else {
      return ""
    }
    return sig.base64EncodedString()
  }

  // MARK: - Keychain

  /// Load the persisted private key, creating it on first use.
  private static func loadOrCreate() throws -> SecKey {
    if let existing = load() { return existing }
    return try create()
  }

  private static func load() -> SecKey? {
    let query: [String: Any] = [
      kSecClass as String: kSecClassKey,
      kSecAttrApplicationTag as String: tag,
      kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
      kSecReturnRef as String: true,
    ]
    var item: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &item)
    guard status == errSecSuccess, let ref = item else { return nil }
    // CFTypeRef → SecKey is a toll-free bridge through Core Foundation.
    return (ref as! SecKey)
  }

  private static func create() throws -> SecKey {
    var privAttrs: [String: Any] = [
      kSecAttrIsPermanent as String: true,
      kSecAttrApplicationTag as String: tag,
    ]
    var attrs: [String: Any] = [
      kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
      kSecAttrKeySizeInBits as String: 256,
    ]

    // Use the Secure Enclave on real hardware; it is unavailable on the Simulator.
    var usingSecureEnclave = false
    #if !targetEnvironment(simulator)
    if let access = SecAccessControlCreateWithFlags(
      kCFAllocatorDefault,
      kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
      .privateKeyUsage,
      nil
    ) {
      attrs[kSecAttrTokenID as String] = kSecAttrTokenIDSecureEnclave
      privAttrs[kSecAttrAccessControl as String] = access
      usingSecureEnclave = true
    }
    #endif
    attrs[kSecPrivateKeyAttrs as String] = privAttrs

    var error: Unmanaged<CFError>?
    if let key = SecKeyCreateRandomKey(attrs as CFDictionary, &error) {
      UserDefaults.standard.set(usingSecureEnclave, forKey: hwFlagKey)
      return key
    }
    // Secure-Enclave creation can fail on some configurations. By default we fall back to a
    // software key so the device still gets a stable identity; a host that sets
    // OTA_REQUIRE_HARDWARE_KEY instead fails closed rather than silently downgrading.
    #if !targetEnvironment(simulator)
    if DashOtaConfig.requireHardwareKey {
      let reason = error?.takeRetainedValue().localizedDescription ?? "unknown"
      throw NSError(
        domain: "DashOtaDeviceKey",
        code: -2,
        userInfo: [NSLocalizedDescriptionKey: "Secure Enclave required (OTA_REQUIRE_HARDWARE_KEY) but unavailable: \(reason)"]
      )
    }
    attrs.removeValue(forKey: kSecAttrTokenID as String)
    privAttrs.removeValue(forKey: kSecAttrAccessControl as String)
    attrs[kSecPrivateKeyAttrs as String] = privAttrs
    if let key = SecKeyCreateRandomKey(attrs as CFDictionary, &error) {
      UserDefaults.standard.set(false, forKey: hwFlagKey)
      return key
    }
    #endif
    let reason = error?.takeRetainedValue().localizedDescription ?? "unknown"
    throw NSError(domain: "DashOtaDeviceKey", code: -1, userInfo: [NSLocalizedDescriptionKey: "device key creation failed: \(reason)"])
  }
}
