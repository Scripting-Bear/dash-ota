import Foundation

/// Reads the per-flavour OTA config that the host app embeds in Info.plist (set per Xcode
/// configuration via xcconfig — the same pattern go-trade uses for Stallion). The public key +
/// runtimeVersion are security-relevant and therefore native, not JS.
enum DashOtaConfig {
  private static func str(_ key: String, _ def: String) -> String {
    (Bundle.main.object(forInfoDictionaryKey: key) as? String) ?? def
  }

  static var channel: String { str("OTA_CHANNEL", "dev") }
  static var serverUrl: String { str("OTA_SERVER_URL", "") }
  /// comma-separated raw base64 Ed25519 public keys (a key ring for rotation).
  static var publicKeysB64: String { str("OTA_PUBLIC_KEYS", "") }
  static var runtimeVersion: String { str("OTA_RUNTIME_VERSION", "embedded") }
  static var nativeBuild: Int { Int(str("CFBundleVersion", "0")) ?? 0 }
}
