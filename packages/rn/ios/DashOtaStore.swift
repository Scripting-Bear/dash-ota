import Foundation

/// On-disk slot + state manager (the iOS twin of the Kotlin `DashOtaStore`). Holds the
/// active / last-known-good / staged / pending bundles + crash-loop counters, and implements
/// the launch-time apply / revert logic. GC keeps only current + last-known-good.
final class DashOtaStore {
  static let shared = DashOtaStore()
  private let maxBootAttempts = 2
  private let bundleFile = "main.jsbundle"
  private let fm = FileManager.default

  private var baseDir: URL {
    let dir = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("dash-ota")
    try? fm.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir
  }
  var bundlesDir: URL {
    let d = baseDir.appendingPathComponent("bundles"); try? fm.createDirectory(at: d, withIntermediateDirectories: true); return d
  }
  var tmpDir: URL {
    let d = baseDir.appendingPathComponent("tmp"); try? fm.createDirectory(at: d, withIntermediateDirectories: true); return d
  }
  private var stateURL: URL { baseDir.appendingPathComponent("state.json") }

  func loadState() -> [String: Any] {
    guard let data = try? Data(contentsOf: stateURL),
          let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [:] }
    return obj
  }

  func saveState(_ state: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: state) else { return }
    let tmp = baseDir.appendingPathComponent("state.json.tmp")
    try? data.write(to: tmp)
    try? fm.removeItem(at: stateURL)
    try? fm.moveItem(at: tmp, to: stateURL)
  }

  private func slot(_ state: [String: Any], _ key: String) -> [String: Any]? { state[key] as? [String: Any] }

  func currentBundleVersion() -> Int { (slot(loadState(), "current")?["version"] as? Int) ?? 0 }

  func stage(bundleId: String, version: Int, runtimeVersion: String, files: [(path: String, data: Data)]) throws {
    let dir = bundlesDir.appendingPathComponent(bundleId)
    try? fm.removeItem(at: dir)
    try fm.createDirectory(at: dir, withIntermediateDirectories: true)
    for f in files {
      let out = dir.appendingPathComponent(f.path)
      try fm.createDirectory(at: out.deletingLastPathComponent(), withIntermediateDirectories: true)
      try f.data.write(to: out)
    }
    var state = loadState()
    // `nativeBuild` stamps the binary this bundle was staged against — see `isCompatible`.
    state["staged"] = [
      "bundleId": bundleId,
      "version": version,
      "runtimeVersion": runtimeVersion,
      "nativeBuild": DashOtaConfig.nativeBuild,
      "dir": dir.path,
    ]
    saveState(state)
  }

  func promoteStagedToPending() -> Bool {
    var state = loadState()
    guard let staged = slot(state, "staged") else { return false }
    state["pending"] = staged
    state["staged"] = nil
    saveState(state)
    return true
  }

  func markHealthy() {
    var state = loadState()
    guard let current = slot(state, "current") else { return }
    state["lastKnownGood"] = current
    state["trial"] = false
    state["bootAttempts"] = 0
    saveState(state)
    gc()
  }

  func rollback() -> Bool {
    var state = loadState()
    state["current"] = slot(state, "lastKnownGood")
    state["trial"] = false
    state["bootAttempts"] = 0
    state["pending"] = nil
    saveState(state)
    gc()
    return true
  }

  /// Whether a stored slot may still be loaded by THIS binary.
  ///
  /// A bundle is only valid for the binary it was staged against. Two things invalidate it:
  /// `runtimeVersion` (native contract changed, so the JS may call APIs that no longer exist) and
  /// `nativeBuild` (the store shipped a newer build, whose embedded JS is by definition newer than
  /// anything staged before it). Without this, the first launch after a store update loads the
  /// pre-update bundle over the new binary — silently discarding the JS the update just shipped.
  ///
  /// Slots written before this field existed have no `nativeBuild`; they are treated as
  /// incompatible so the upgrade resets cleanly rather than trusting an unverifiable slot.
  private func isCompatible(_ slot: [String: Any]) -> Bool {
    guard (slot["runtimeVersion"] as? String) == DashOtaConfig.runtimeVersion else { return false }
    guard let staged = slot["nativeBuild"] as? Int, staged == DashOtaConfig.nativeBuild else { return false }
    return true
  }

  /// Drop every slot staged against a different binary, so the embedded bundle loads instead.
  /// Returns the cleaned state, and whether anything was discarded.
  private func dropIncompatibleSlots(_ state: [String: Any]) -> (state: [String: Any], dropped: Bool) {
    var next = state
    var dropped = false
    for key in ["pending", "staged", "current", "lastKnownGood"] {
      guard let s = slot(state, key) else { continue }
      if !isCompatible(s) {
        next[key] = nil
        dropped = true
      }
    }
    if dropped {
      // The trial counters belong to a bundle that is no longer loadable.
      next["trial"] = false
      next["bootAttempts"] = 0
    }
    return (next, dropped)
  }

  /// Resolve which bundle to load at launch, applying pending + the crash-loop circuit breaker.
  func resolveBundleAtLaunch() -> String? {
    var state = loadState()

    // Before anything else: a binary that changed underneath us (store update / sideload) must not
    // run bundles staged for the previous one.
    let cleaned = dropIncompatibleSlots(state)
    if cleaned.dropped {
      state = cleaned.state
      saveState(state)
      gc()
    }

    if let pending = slot(state, "pending") {
      state["current"] = pending
      state["pending"] = nil
      state["trial"] = true
      state["bootAttempts"] = 1
      saveState(state)
      return bundlePath(pending)
    }
    guard let current = slot(state, "current") else { return nil }
    if (state["trial"] as? Bool) == true {
      let attempts = (state["bootAttempts"] as? Int) ?? 0
      if attempts >= maxBootAttempts {
        // Crash loop → disable the bundle (never re-stage) + remember it to report once.
        let failedId = (current["bundleId"] as? String) ?? ""
        var disabled = (state["disabledBundles"] as? [String]) ?? []
        if !failedId.isEmpty && !disabled.contains(failedId) { disabled.append(failedId) }
        state["disabledBundles"] = disabled
        state["failedToReport"] = failedId
        let lkg = slot(state, "lastKnownGood")
        state["current"] = lkg
        state["trial"] = false
        state["bootAttempts"] = 0
        saveState(state)
        gc()
        return lkg.flatMap { bundlePath($0) }
      }
      state["bootAttempts"] = attempts + 1
      saveState(state)
      return bundlePath(current)
    }
    return bundlePath(current)
  }

  func currentMeta() -> [String: Any] {
    let current = slot(loadState(), "current")
    return [
      "bundleId": current?["bundleId"] as? String ?? "embedded",
      "bundleVersion": current?["version"] as? Int ?? 0,
      "isEmbedded": current == nil,
    ]
  }

  /// True if a bundle was disabled by the crash-loop breaker.
  func isDisabled(_ bundleId: String) -> Bool {
    ((loadState()["disabledBundles"] as? [String]) ?? []).contains(bundleId)
  }

  /// Return + clear the bundleId most recently disabled by a crash-loop revert (report once).
  func consumeFailedReport() -> String {
    var state = loadState()
    let failed = (state["failedToReport"] as? String) ?? ""
    if !failed.isEmpty {
      state["failedToReport"] = nil
      saveState(state)
    }
    return failed
  }

  private func bundlePath(_ slot: [String: Any]) -> String? {
    // Resolve from the RUNTIME container + bundleId — never from the stored absolute `dir`.
    // iOS mints a new data-container UUID on every app update/reinstall (files are migrated), so a
    // stored absolute path goes stale and RN's bundle load would RCTFatal on the first boot after
    // every store update. The stored `dir` remains for debugging only.
    guard let bundleId = slot["bundleId"] as? String, !bundleId.isEmpty else { return nil }
    let path = bundlesDir.appendingPathComponent(bundleId).appendingPathComponent(bundleFile).path
    // Missing/unreadable bundle file → fall back to the embedded bundle instead of a boot crash
    // (also covers a lastKnownGood slot whose files vanished — trials are breaker-guarded, LKG is not).
    guard fm.fileExists(atPath: path) else { return nil }
    return path
  }

  private func gc() {
    let state = loadState()
    // Keep-set by bundleId (stable across container migrations) — matching on stored absolute
    // paths would consider every live dir unknown after a migration and delete current + LKG.
    let keep = Set(
      [slot(state, "current")?["bundleId"] as? String, slot(state, "lastKnownGood")?["bundleId"] as? String]
        .compactMap { $0 }
    )
    let dirs = (try? fm.contentsOfDirectory(at: bundlesDir, includingPropertiesForKeys: nil)) ?? []
    for d in dirs where !keep.contains(d.lastPathComponent) { try? fm.removeItem(at: d) }
  }
}
