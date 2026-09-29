import CryptoKit
import Foundation
import Security
import UIKit

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
    let chain = (SecTrustCopyCertificateChain(trust) as? [SecCertificate]) ?? []
    for cert in chain {
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
  private var resignObserver: NSObjectProtocol?
  private var activeObserver: NSObjectProtocol?

  /// Constructed when React Native creates the TurboModule, i.e. the first time JS touches it.
  /// Two jobs, both feeding the crash-loop breaker in `DashOtaStore.resolveBundleAtLaunch()`:
  ///
  ///  - being constructed at all proves the running bundle reached its JS runtime (the *beacon*);
  ///  - the resign-active observer lets the store tell a user-driven exit from a crash.
  ///
  /// Without the pair, a user swiping the app away twice inside the health window walks a perfectly
  /// healthy bundle into the breaker and gets it blocklisted. `willResignActive` is used rather
  /// than `didEnterBackground` because a swipe-kill from the app switcher only guarantees the
  /// former.
  @objc public override init() {
    super.init()
    DashOtaStore.shared.markBeacon()
    resignObserver = NotificationCenter.default.addObserver(
      forName: UIApplication.willResignActiveNotification,
      object: nil,
      queue: nil
    ) { _ in DashOtaStore.shared.markPaused() }
    activeObserver = NotificationCenter.default.addObserver(
      forName: UIApplication.didBecomeActiveNotification,
      object: nil,
      queue: nil
    ) { _ in DashOtaStore.shared.clearPaused() }
  }

  deinit {
    if let o = resignObserver { NotificationCenter.default.removeObserver(o) }
    if let o = activeObserver { NotificationCenter.default.removeObserver(o) }
  }

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

  @objc public func consumeAppliedReport() -> String { DashOtaStore.shared.consumeAppliedReport() }

  @objc public func applyOnNextLaunch() -> Bool { DashOtaStore.shared.promoteStagedToPending() }
  @objc public func markUserReload() { DashOtaStore.shared.markUserReload() }
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
  @objc public func downloadAndStage(_ blobBaseUrl: String, downloadToken: String, manifestJson: String, signatureB64: String) throws -> NSDictionary {
    // Signature first: nothing in the manifest is trustworthy until it verifies, including the
    // sizes used to bound every download below.
    let keys = DashOtaConfig.publicKeysB64.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
    let manifestData = Data(manifestJson.utf8)
    guard let sig = DashOtaCrypto.b64(signatureB64),
          DashOtaCrypto.ed25519VerifyAny(publicKeysB64: keys, message: manifestData, signature: sig) else {
      throw DashOtaError.message("manifest signature did not verify")
    }
    guard let manifest = try JSONSerialization.jsonObject(with: manifestData) as? [String: Any] else {
      throw DashOtaError.message("bad manifest json")
    }
    guard (manifest["schema"] as? Int) == 2 else {
      throw DashOtaError.message("manifest schema is not 2 — this binary speaks the v2 wire format only")
    }
    guard let appId = manifest["appId"] as? String, appId == Bundle.main.bundleIdentifier else {
      throw DashOtaError.message("manifest was built for a different app")
    }
    guard (manifest["runtimeVersion"] as? String) == DashOtaConfig.runtimeVersion else {
      throw DashOtaError.message("runtimeVersion does not match this binary")
    }
    // The server already filters by channel and platform; these stop a breached one serving another
    // channel's release that the same key ring verifies.
    guard (manifest["channel"] as? String) == DashOtaConfig.channel else {
      throw DashOtaError.message("manifest is for another channel")
    }
    guard (manifest["platform"] as? String) == "ios" else {
      throw DashOtaError.message("manifest is for another platform")
    }
    if let minNative = manifest["minNativeBuild"] as? Int, DashOtaConfig.nativeBuild < minNative {
      throw DashOtaError.message("bundle needs native build \(minNative) or later")
    }
    guard let version = manifest["bundleVersion"] as? Int, version > DashOtaStore.shared.currentBundleVersion() else {
      throw DashOtaError.message("bundleVersion is not newer")
    }
    guard let bundleId = manifest["bundleId"] as? String,
          let encryption = manifest["encryption"] as? [String: Any],
          let entries = manifest["files"] as? [[String: Any]], !entries.isEmpty else {
      throw DashOtaError.message("malformed manifest")
    }
    // bundleId and every sha256 become directory and file names below.
    guard Self.matches(bundleId, Self.bundleIdPattern) else {
      throw DashOtaError.message("bundleId \(bundleId) is not a safe file name")
    }
    if DashOtaStore.shared.isDisabled(bundleId) {
      throw DashOtaError.message("bundle was disabled after a crash loop")
    }

    // Every path is checked before anything is written: a valid signature over "../../x" is still
    // a valid signature.
    for entry in entries {
      guard let path = entry["path"] as? String else { throw DashOtaError.message("manifest entry has no path") }
      if let reason = Self.invalidPath(path) {
        throw DashOtaError.message("manifest path \(path) \(reason)")
      }
      let blobSha = (entry["blob"] as? [String: Any])?["sha256"] as? String ?? ""
      guard Self.matches(entry["sha256"] as? String ?? "", Self.sha256Pattern), Self.matches(blobSha, Self.sha256Pattern) else {
        throw DashOtaError.message("manifest entry \(path) has a malformed sha256")
      }
    }

    var contentKey: Data?
    if (encryption["mode"] as? String) == "aes-256-gcm" {
      guard let key = DashOtaCrypto.b64(encryption["contentKeyB64"] as? String ?? "") else {
        throw DashOtaError.message("bad content key")
      }
      contentKey = key
    }

    let fm = FileManager.default
    let staging = DashOtaStore.shared.stagingDir(bundleId)
    let have = DashOtaStore.shared.haveFiles()
    var fileMap: [String: String] = [:]
    var bundleSha = ""

    for entry in entries {
      guard let path = entry["path"] as? String,
            let plainSha = entry["sha256"] as? String,
            let size = entry["size"] as? Int,
            let blob = entry["blob"] as? [String: Any],
            let blobSha = blob["sha256"] as? String,
            let blobSize = blob["size"] as? Int else {
        throw DashOtaError.message("malformed file entry")
      }
      if (entry["role"] as? String) == "bundle" { bundleSha = plainSha }
      fileMap[path] = plainSha

      let out = staging.appendingPathComponent(path)
      try fm.createDirectory(at: out.deletingLastPathComponent(), withIntermediateDirectories: true)

      // Already assembled by an earlier, interrupted attempt.
      if let existing = (try? fm.attributesOfItem(atPath: out.path))?[.size] as? NSNumber,
         existing.intValue == size,
         (try? DashOtaCrypto.sha256HexOfFile(out)) == plainSha {
        continue
      }

      // The file is already on this device: copy it instead of fetching it, then re-hash anyway,
      // because "already on disk" is never evidence that a file is correct.
      if let reusable = have[plainSha] {
        try? fm.removeItem(at: out)
        try fm.copyItem(at: reusable, to: out)
        guard (try? DashOtaCrypto.sha256HexOfFile(out)) == plainSha else {
          try? fm.removeItem(at: out)
          throw DashOtaError.message("reused file \(path) did not verify")
        }
        continue
      }

      let part = DashOtaStore.shared.tmpDir.appendingPathComponent("\(blobSha).part")
      let body = try downloadSync("\(blobBaseUrl)/\(blobSha)", token: downloadToken, expectedSize: blobSize)
      try body.write(to: part, options: .atomic)
      guard (try? DashOtaCrypto.sha256HexOfFile(part)) == blobSha else {
        try? fm.removeItem(at: part)
        throw DashOtaError.message("blob \(blobSha) did not verify")
      }

      // Verified bytes only from here: decrypt, then decompress, then check the plaintext. Every
      // step is file-to-file — a decompressed Hermes bundle is the largest single allocation this
      // path could make, and it is never held in memory.
      let tmpOut = staging.appendingPathComponent("\(path).part")
      var sealed = part
      if let contentKey {
        guard let iv = DashOtaCrypto.b64(blob["ivB64"] as? String ?? ""),
              let tag = DashOtaCrypto.b64(blob["tagB64"] as? String ?? "") else {
          try? fm.removeItem(at: part)
          throw DashOtaError.message("blob \(blobSha) is missing its iv or tag")
        }
        let decrypted = DashOtaStore.shared.tmpDir.appendingPathComponent("\(blobSha).dec")
        do {
          try DashOtaCrypto.aesGcmDecryptToFile(
            key: contentKey, iv: iv, src: part, tag: tag,
            // AAD binds the ciphertext to the plaintext it claims to be, and deliberately not to
            // the release: one blob is shared by every release containing that file.
            aad: Data(plainSha.utf8), dest: decrypted
          )
        } catch {
          try? fm.removeItem(at: part)
          throw DashOtaError.message("blob \(blobSha) did not authenticate")
        }
        try? fm.removeItem(at: part)
        sealed = decrypted
      }

      let writtenSha: String
      do {
        if (blob["compression"] as? String) == "zstd" {
          writtenSha = try DashOtaCrypto.zstdDecompressToFile(src: sealed, dest: tmpOut, expectedSize: size)
        } else {
          try? fm.removeItem(at: tmpOut)
          try fm.moveItem(at: sealed, to: tmpOut)
          writtenSha = try DashOtaCrypto.sha256HexOfFile(tmpOut)
        }
      } catch {
        try? fm.removeItem(at: sealed)
        try? fm.removeItem(at: tmpOut)
        throw error
      }
      try? fm.removeItem(at: sealed)

      let written = ((try? fm.attributesOfItem(atPath: tmpOut.path))?[.size] as? NSNumber)?.intValue ?? -1
      guard written == size, writtenSha == plainSha else {
        try? fm.removeItem(at: tmpOut)
        throw DashOtaError.message("file \(path) did not verify")
      }

      // Rename into place only now, so a kill never leaves a short file that a later resume would
      // mistake for a complete one.
      try? fm.removeItem(at: out)
      try fm.moveItem(at: tmpOut, to: out)
    }

    try DashOtaStore.shared.commitStaged(
      bundleId: bundleId,
      version: version,
      runtimeVersion: DashOtaConfig.runtimeVersion,
      bundleSha256: bundleSha,
      files: fileMap
    )
    return ["bundleId": bundleId, "bundleVersion": version] as NSDictionary
  }

  /// Reject anything that could escape the staging directory or confuse the file system.
  ///
  /// Mirrors `validatePath` in `@dash-ota/shared` and `invalidPath` on Android; all three must
  /// agree, or a release that publishes cleanly fails on one platform only.
  static func invalidPath(_ path: String) -> String? {
    if path.isEmpty { return "is empty" }
    if path.utf8.count > 512 { return "is longer than 512 bytes" }
    if path.contains("\0") { return "contains NUL" }
    if path.contains("\\") { return "contains a backslash" }
    if path.hasPrefix("/") { return "is absolute" }
    if path.count >= 2, path[path.index(path.startIndex, offsetBy: 1)] == ":" { return "has a drive letter" }
    for segment in path.split(separator: "/", omittingEmptySubsequences: false) {
      if segment.isEmpty { return "has an empty segment" }
      if segment == "." || segment == ".." { return "contains a \(segment) segment" }
    }
    return nil
  }

  /// `\z`, not `$`: ICU's `$` also matches before a trailing newline.
  static let bundleIdPattern = #"^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}\z"#
  static let sha256Pattern = #"^[0-9a-f]{64}\z"#

  static func matches(_ value: String, _ pattern: String) -> Bool {
    value.range(of: pattern, options: .regularExpression) != nil
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
    // When pinning is on, refuse a non-https URL — an http:// download (misconfig or SSL-strip)
    // never triggers a server-trust challenge, so the pin would silently not be enforced.
    if !pins.isEmpty, url.scheme?.lowercased() != "https" {
      throw DashOtaError.message("TLS pinning is enabled but the download URL is not https")
    }
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
      throw DashOtaError.message("download size \(data.count) != the \(expectedSize) bytes the signed manifest promised")
    }
    return data
  }
}
