import CryptoKit
import Foundation
import Security

/// URLSession delegate that pins the server certificate for the bundle download: the request is
/// rejected unless a certificate in the chain matches a configured `base64(SHA-256(DER cert))` pin.
/// Only installed when `OTA_TLS_PINS` is non-empty (pinning is off by default). Cross-platform
/// identical to the Android `ota_tls_pins` format.
private final class DashOtaPinningDelegate: NSObject, URLSessionDelegate {
  private let pins: Set<String>
  init(pins: Set<String>) { self.pins = pins }

  func urlSession(
    _ session: URLSession,
    didReceive challenge: URLAuthenticationChallenge,
    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
  ) {
    guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
          let trust = challenge.protectionSpace.serverTrust else {
      completionHandler(.performDefaultHandling, nil)
      return
    }
    // Require the OS chain validation to pass first, then require a pin match (belt and braces).
    var error: CFError?
    guard SecTrustEvaluateWithError(trust, &error) else {
      completionHandler(.cancelAuthenticationChallenge, nil)
      return
    }
    let count = SecTrustGetCertificateCount(trust)
    for i in 0..<count {
      guard let cert = SecTrustGetCertificateAtIndex(trust, i) else { continue }
      let der = SecCertificateCopyData(cert) as Data
      let pin = Data(SHA256.hash(data: der)).base64EncodedString()
      if pins.contains(pin) {
        completionHandler(.useCredential, URLCredential(trust: trust))
        return
      }
    }
    completionHandler(.cancelAuthenticationChallenge, nil)
  }
}

/// @objc bridge the Obj-C++ TurboModule (`DashOta.mm`) forwards to. Holds the trust-critical
/// pipeline (verify → decrypt → unpack → per-file hash → stage) so the heavy/secret work stays
/// in native and off the JS thread. Throwing methods surface to Obj-C as `(NSError**)`.
@objc(DashOtaImpl)
public class DashOtaImpl: NSObject {
  @objc public static func runtimeVersion() -> String { DashOtaConfig.runtimeVersion }
  @objc public static func channel() -> String { DashOtaConfig.channel }
  @objc public static func serverUrl() -> String { DashOtaConfig.serverUrl }
  @objc public static func publicKeysB64() -> String { DashOtaConfig.publicKeysB64 }
  @objc public static func nativeBuild() -> Int { DashOtaConfig.nativeBuild }

  @objc public func currentBundleMeta() -> NSDictionary {
    var meta = DashOtaStore.shared.currentMeta()
    meta["runtimeVersion"] = DashOtaConfig.runtimeVersion
    return meta as NSDictionary
  }

  @objc public func state() -> NSDictionary {
    let s = DashOtaStore.shared.loadState()
    let pending = (s["pending"] as? [String: Any])?["bundleId"] as? String
    let lkg = (s["lastKnownGood"] as? [String: Any])?["version"] as? Int ?? 0
    let currentId = (DashOtaStore.shared.currentMeta()["bundleId"] as? String) ?? ""
    return [
      "currentBundleVersion": DashOtaStore.shared.currentBundleVersion(),
      "pendingBundleId": pending as Any,
      "lastKnownGoodVersion": lkg,
      "otaDisabled": !currentId.isEmpty && DashOtaStore.shared.isDisabled(currentId),
    ] as NSDictionary
  }

  @objc public func isBundleDisabled(_ bundleId: String) -> Bool { DashOtaStore.shared.isDisabled(bundleId) }
  @objc public func consumeFailedReport() -> String { DashOtaStore.shared.consumeFailedReport() }

  @objc public func applyOnNextLaunch() -> Bool { DashOtaStore.shared.promoteStagedToPending() }
  @objc public func markHealthy() { DashOtaStore.shared.markHealthy() }
  @objc public func rollback() -> Bool { DashOtaStore.shared.rollback() }

  // --- Hardware-backed device identity (asymmetric; no shared secret) ---
  @objc public func getDevicePublicKeyB64() -> String { DashOtaDeviceKey.publicKeyB64() }
  @objc public func signWithDeviceKey(_ message: String) -> String { DashOtaDeviceKey.signB64(message) }
  @objc public func isDeviceKeyHardwareBacked() -> Bool { DashOtaDeviceKey.isHardwareBacked() }

  @objc public func sha256Hex(_ message: String) -> String { DashOtaCrypto.sha256Hex(Data(message.utf8)) }

  /// Cryptographically-secure 16-byte nonce (base64url, unpadded) from `SecRandomCopyBytes`, for anti-replay.
  @objc public func generateNonce() -> String {
    var bytes = [UInt8](repeating: 0, count: 16)
    if SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) != errSecSuccess {
      return UUID().uuidString // vanishingly unlikely; still unpredictable
    }
    return Data(bytes).base64EncodedString()
      .replacingOccurrences(of: "+", with: "-")
      .replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: "=", with: "")
  }

  /// Download → Ed25519-verify → AES-GCM decrypt → unpack → per-file hash → stage. Throws on
  /// any failure (fail closed). Returns `{ bundleId, bundleVersion }`.
  @objc public func downloadAndStage(_ downloadUrl: String, downloadToken: String, manifestJson: String, signatureB64: String) throws -> NSDictionary {
    let keys = DashOtaConfig.publicKeysB64.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
    let manifestData = Data(manifestJson.utf8)
    guard let sig = DashOtaCrypto.b64(signatureB64),
          DashOtaCrypto.ed25519VerifyAny(publicKeysB64: keys, message: manifestData, signature: sig) else {
      throw DashOtaError.message("manifest signature did not verify")
    }
    guard let manifest = try JSONSerialization.jsonObject(with: manifestData) as? [String: Any] else {
      throw DashOtaError.message("bad manifest json")
    }
    guard (manifest["runtimeVersion"] as? String) == DashOtaConfig.runtimeVersion else {
      throw DashOtaError.message("runtimeVersion does not match this binary")
    }
    guard let version = manifest["bundleVersion"] as? Int, version > DashOtaStore.shared.currentBundleVersion() else {
      throw DashOtaError.message("bundleVersion is not newer")
    }
    guard let bundleId = manifest["bundleId"] as? String, let enc = manifest["encryption"] as? [String: Any] else {
      throw DashOtaError.message("malformed manifest")
    }
    if DashOtaStore.shared.isDisabled(bundleId) {
      throw DashOtaError.message("bundle was disabled after a crash loop")
    }

    // The manifest is already Ed25519-verified, so its signed ciphertextSize is trustworthy — use
    // it to bound the download (rejects a MITM-swapped/oversized body).
    guard let expectedSize = enc["ciphertextSize"] as? Int else {
      throw DashOtaError.message("manifest missing encryption.ciphertextSize")
    }
    let ciphertext = try downloadSync(downloadUrl, token: downloadToken, expectedSize: expectedSize)
    guard DashOtaCrypto.sha256Hex(ciphertext) == (enc["ciphertextSha256"] as? String) else {
      throw DashOtaError.message("ciphertext hash mismatch")
    }
    guard let keyData = DashOtaCrypto.b64(enc["contentKeyB64"] as? String ?? ""),
          let iv = DashOtaCrypto.b64(enc["ivB64"] as? String ?? ""),
          let tag = DashOtaCrypto.b64(enc["tagB64"] as? String ?? "") else {
      throw DashOtaError.message("bad encryption params")
    }
    let archive = try DashOtaCrypto.aesGcmDecrypt(key: keyData, iv: iv, ciphertext: ciphertext, tag: tag)
    let files = try DashOtaCrypto.unpackArchive(archive)

    guard let manifestFiles = manifest["files"] as? [[String: Any]], manifestFiles.count == files.count else {
      throw DashOtaError.message("file count mismatch")
    }
    var expected: [String: [String: Any]] = [:]
    for fe in manifestFiles { if let p = fe["path"] as? String { expected[p] = fe } }
    for f in files {
      guard let fe = expected[f.path], (fe["size"] as? Int) == f.data.count, (fe["sha256"] as? String) == DashOtaCrypto.sha256Hex(f.data) else {
        throw DashOtaError.message("file hash/size mismatch: \(f.path)")
      }
    }

    try DashOtaStore.shared.stage(bundleId: bundleId, version: version, runtimeVersion: DashOtaConfig.runtimeVersion, files: files)
    return ["bundleId": bundleId, "bundleVersion": version] as NSDictionary
  }

  private func downloadSync(_ urlStr: String, token: String, expectedSize: Int) throws -> Data {
    guard let url = URL(string: urlStr) else { throw DashOtaError.message("bad download url") }
    var req = URLRequest(url: url)
    req.httpMethod = "GET"
    req.setValue(token, forHTTPHeaderField: "x-ota-download-token")
    req.timeoutInterval = 30

    // Optional certificate pinning (off unless OTA_TLS_PINS is set): install a pinning delegate.
    let pins = Set(
      DashOtaConfig.tlsPinsB64
        .split(separator: ",")
        .map { $0.trimmingCharacters(in: .whitespaces) }
        .filter { !$0.isEmpty }
    )
    let session: URLSession =
      pins.isEmpty
      ? URLSession.shared
      : URLSession(configuration: .default, delegate: DashOtaPinningDelegate(pins: pins), delegateQueue: nil)
    defer { if session !== URLSession.shared { session.finishTasksAndInvalidate() } }

    let sem = DispatchSemaphore(value: 0)
    var result: Data?
    var taskError: Error?
    var status = 0
    session.dataTask(with: req) { data, resp, err in
      if let http = resp as? HTTPURLResponse { status = http.statusCode }
      result = data
      taskError = err
      sem.signal()
    }.resume()
    sem.wait()
    if let taskError = taskError { throw taskError }
    guard status == 200, let data = result else { throw DashOtaError.message("download HTTP \(status)") }
    // Enforce the signed size. NOTE (Phase 5): dataTask buffers the whole body first, so a fully
    // streaming bounded download (a URLSessionDataDelegate that cancels past the cap) is the
    // stronger memory-DoS fix; this equality check already rejects a swapped/oversized bundle.
    guard data.count == expectedSize else {
      throw DashOtaError.message("download size \(data.count) != signed ciphertextSize \(expectedSize)")
    }
    return data
  }
}
