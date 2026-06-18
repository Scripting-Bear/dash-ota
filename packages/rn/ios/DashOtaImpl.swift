import Foundation

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
    return [
      "currentBundleVersion": DashOtaStore.shared.currentBundleVersion(),
      "pendingBundleId": pending as Any,
      "lastKnownGoodVersion": lkg,
      "otaDisabled": false,
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

  @objc public func sha256Hex(_ message: String) -> String { DashOtaCrypto.sha256Hex(Data(message.utf8)) }

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

    let ciphertext = try downloadSync(downloadUrl, token: downloadToken)
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

  private func downloadSync(_ urlStr: String, token: String) throws -> Data {
    guard let url = URL(string: urlStr) else { throw DashOtaError.message("bad download url") }
    var req = URLRequest(url: url)
    req.httpMethod = "GET"
    req.setValue(token, forHTTPHeaderField: "x-ota-download-token")
    req.timeoutInterval = 30
    let sem = DispatchSemaphore(value: 0)
    var result: Data?
    var taskError: Error?
    var status = 0
    URLSession.shared.dataTask(with: req) { data, resp, err in
      if let http = resp as? HTTPURLResponse { status = http.statusCode }
      result = data
      taskError = err
      sem.signal()
    }.resume()
    sem.wait()
    if let taskError = taskError { throw taskError }
    guard status == 200, let data = result else { throw DashOtaError.message("download HTTP \(status)") }
    return data
  }
}
