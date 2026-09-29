import Foundation
import os

/// On-disk slot + state manager (the iOS twin of the Kotlin `DashOtaStore`). Holds the
/// active / last-known-good / staged / pending bundles + crash-loop counters, and implements
/// the launch-time apply / revert logic. GC keeps every slot the state still references.
final class DashOtaStore {
  static let shared = DashOtaStore()
  private let maxBootAttempts = 2
  private let bundleFile = "main.jsbundle"
  private let fm = FileManager.default
  /// Bumped when the on-disk state shape changes in a way older slots cannot survive.
  private let stateSchema = 2
  private let markLock = NSLock()

  /// One line per cold start saying which bundle was chosen and why. Native on purpose: release
  /// builds strip the JS `console.*` trail, so this is the only way to see the launch decision on a
  /// real device. Every value is interpolated `.public` because the log is useless when redacted —
  /// it carries only bundle ids and counters, never tokens, keys or user data.
  private let log = Logger(subsystem: "dash-ota", category: "launch")
  private var schemaResetLogged = false

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

  /// Per-launch marks live in their own file, NOT in `state.json`. They are written from the main
  /// thread by the app lifecycle notifications, and a read-modify-write of the whole state from
  /// there can lose a concurrent `markHealthy()` on the JS thread.
  private var launchURL: URL { baseDir.appendingPathComponent("launch.json") }

  func loadState() -> [String: Any] {
    guard let data = try? Data(contentsOf: stateURL),
          let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
      return ["stateSchema": stateSchema]
    }
    // Slots written before schema 2 were staged by a loader that spent a boot attempt on every host
    // read of the bundle path, so the breaker disabled them on their first boot and deleted the slot
    // dir under the running bundle. Discard, don't migrate: the embedded bundle runs and the next
    // check re-downloads.
    if (obj["stateSchema"] as? Int ?? 1) != stateSchema {
      if !schemaResetLogged {
        schemaResetLogged = true
        log.warning("launch: state schema is not \(self.stateSchema, privacy: .public) — discarding it and starting clean")
      }
      return ["stateSchema": stateSchema]
    }
    return obj
  }

  /// JS initialised the TurboModule in this process, so the running bundle reached its runtime.
  func markBeacon() { markLaunch("beaconAt") }

  /// The app resigned active. A crash never gets to write this, which is what separates
  /// "the user swiped the app away" from "the bundle died".
  func markPaused() { markLaunch("pausedAt") }

  /// The app came back to the foreground, so whatever paused it was an interruption, not the user
  /// leaving. Without this a bundle that resigns active, becomes active and *then* crashes would be
  /// forgiven; it also discards the transient resign-active iOS raises for a banner or a call.
  func clearPaused() {
    markLock.lock()
    defer { markLock.unlock() }
    var marks = readLaunchMarks()
    guard marks["pausedAt"] != nil else { return }
    marks["pausedAt"] = nil
    writeLaunchMarks(marks)
  }

  private func markLaunch(_ key: String) {
    markLock.lock()
    defer { markLock.unlock() }
    var marks = readLaunchMarks()
    guard marks[key] == nil else { return }
    marks[key] = Int(Date().timeIntervalSince1970 * 1000)
    writeLaunchMarks(marks)
  }

  /// Read the marks the PREVIOUS process left, and reset them for this one.
  private func consumeLaunchMarks() -> [String: Any] {
    markLock.lock()
    defer { markLock.unlock() }
    let marks = readLaunchMarks()
    try? fm.removeItem(at: launchURL)
    return marks
  }

  /// Unreadable marks mean "no marks", which counts the launch rather than forgiving it.
  private func readLaunchMarks() -> [String: Any] {
    guard let data = try? Data(contentsOf: launchURL),
          let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [:] }
    return obj
  }

  private func writeLaunchMarks(_ marks: [String: Any]) {
    // Losing a mark only costs a refund; never let it break a lifecycle callback.
    guard let data = try? JSONSerialization.data(withJSONObject: marks) else { return }
    try? data.write(to: launchURL)
  }

  func saveState(_ input: [String: Any]) {
    var state = input
    state["stateSchema"] = stateSchema
    guard let data = try? JSONSerialization.data(withJSONObject: state) else { return }
    let tmp = baseDir.appendingPathComponent("state.json.tmp")
    try? data.write(to: tmp)
    try? fm.removeItem(at: stateURL)
    try? fm.moveItem(at: tmp, to: stateURL)
  }

  private func slot(_ state: [String: Any], _ key: String) -> [String: Any]? { state[key] as? [String: Any] }

  func currentBundleVersion() -> Int { (slot(loadState(), "current")?["version"] as? Int) ?? 0 }

  /// Where a download assembles a release before it becomes a real slot.
  ///
  /// It survives process death on purpose, so an interrupted download resumes instead of starting
  /// over.
  func stagingDir(_ bundleId: String) -> URL {
    let dir = stagingRoot.appendingPathComponent(bundleId)
    try? fm.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir
  }

  var stagingRoot: URL { baseDir.appendingPathComponent("staging") }

  /// Files this device already holds, keyed by plaintext hash, for the next update to reuse.
  ///
  /// Only slots that are actually loadable count: `current` and `lastKnownGood`. Each entry is
  /// checked for existence, because a slot record outliving its directory is exactly the state a
  /// half-finished update leaves behind.
  func haveFiles() -> [String: URL] {
    var out: [String: URL] = [:]
    let state = loadState()
    for key in ["current", "lastKnownGood"] {
      guard let slot = slot(state, key),
            let bundleId = slot["bundleId"] as? String, !bundleId.isEmpty,
            let files = slot["files"] as? [String: String] else { continue }
      let dir = bundlesDir.appendingPathComponent(bundleId)
      for (path, sha) in files where !sha.isEmpty && out[sha] == nil {
        let url = dir.appendingPathComponent(path)
        if fm.fileExists(atPath: url.path) { out[sha] = url }
      }
    }
    return out
  }

  /// Promote a fully-assembled staging directory into a real slot, atomically.
  ///
  /// A kill in between leaves the staging dir for the next attempt, never a half-written slot.
  ///
  /// - Throws: if the staging directory does not contain every file the manifest promised. Without
  ///   that check the state file can advertise a file the directory lacks, the bundle boots, and
  ///   the missing asset renders blank with nothing in any log — the 2026-09-08 symptom arriving
  ///   by a different route.
  func commitStaged(
    bundleId: String,
    version: Int,
    runtimeVersion: String,
    bundleSha256: String,
    files: [String: String]
  ) throws {
    let staging = stagingDir(bundleId)

    let missing = files.keys.filter { path in
      let url = staging.appendingPathComponent(path)
      guard let size = (try? fm.attributesOfItem(atPath: url.path))?[.size] as? NSNumber else { return true }
      return size.intValue == 0
    }
    if !missing.isEmpty {
      try? fm.removeItem(at: staging)
      throw DashOtaError.message("staged bundle \(bundleId) is missing \(missing.count) file(s): \(missing.prefix(5))")
    }

    let dir = bundlesDir.appendingPathComponent(bundleId)
    try? fm.removeItem(at: dir)
    try fm.createDirectory(at: dir.deletingLastPathComponent(), withIntermediateDirectories: true)
    do {
      try fm.moveItem(at: staging, to: dir)
    } catch {
      // Across-filesystem move can fail; fall back to a copy, then drop the staging copy.
      try fm.copyItem(at: staging, to: dir)
      try? fm.removeItem(at: staging)
    }

    var state = loadState()
    // `nativeBuild` stamps the binary this bundle was staged against — see `isCompatible`.
    state["staged"] = [
      "bundleId": bundleId,
      "version": version,
      "runtimeVersion": runtimeVersion,
      "nativeBuild": DashOtaConfig.nativeBuild,
      "bundleSha256": bundleSha256,
      "files": files,
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
  }

  func rollback() -> Bool {
    var state = loadState()
    state["current"] = slot(state, "lastKnownGood")
    state["trial"] = false
    state["bootAttempts"] = 0
    state["pending"] = nil
    saveState(state)
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

  /// Record that the NEXT launch is a deliberate in-process reload (the user tapped "restart to
  /// apply"), not a fresh cold start. One-shot: `resolveBundleAtLaunch` consumes it.
  func markUserReload() {
    var state = loadState()
    state["userReload"] = true
    saveState(state)
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
    }

    // A reload the user asked for is not evidence of a crash. Consume the marker and let this launch
    // pass without spending a boot attempt — otherwise impatient tapping on "restart to apply" walks
    // a perfectly healthy bundle into the crash-loop breaker and blocklists it. Genuine cold starts
    // still count, so a bundle that really crashes on boot is still caught.
    let userReload = (state["userReload"] as? Bool) == true
    if userReload { state["userReload"] = nil }

    // Marks left behind by the PREVIOUS process. Reaching JS and then resigning active is what a
    // user swiping the app away looks like; a crash cannot produce both, because the resign-active
    // callback never runs. So that launch is refunded below instead of counting as a crash.
    let prev = consumeLaunchMarks()
    let forgiven = prev["beaconAt"] != nil && prev["pausedAt"] != nil

    // The only safe moment to sweep slots, and therefore the only place gc is called.
    //
    // Nothing is mapped yet this process and no download can be in flight, because JS has not
    // started. `markHealthy` and `rollback` used to call it too, at arbitrary times, and gc
    // deletes any staging directory it does not recognise — a download in progress has not
    // written `staged` yet. Marking healthy mid-download therefore deleted files that had already
    // been assembled; the update committed with them still listed in its state and each rendered
    // blank. Reproduced on Android 2026-09-10; this side is the same shape.
    gc(state)

    if let pending = slot(state, "pending") {
      state["current"] = pending
      state["pending"] = nil
      state["trial"] = true
      state["bootAttempts"] = 1
      // Report the apply exactly once. Only this launch knows a pending bundle became current; by
      // the next one it is indistinguishable from a bundle that has been running for days.
      state["appliedToReport"] = pending["bundleId"] as? String
      saveState(state)
      log.warning("launch: applying pending \((pending["bundleId"] as? String) ?? "?", privacy: .public) on trial (attempt 1/\(self.maxBootAttempts, privacy: .public))")
      return bundlePath(pending)
    }
    guard let current = slot(state, "current") else {
      saveState(state)
      log.warning("launch: no stored bundle — using the embedded one")
      return nil
    }
    if (state["trial"] as? Bool) == true {
      var attempts = (state["bootAttempts"] as? Int) ?? 0
      if forgiven && attempts > 0 { attempts -= 1 }
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
        log.warning("launch: crash loop: disabling \(failedId, privacy: .public), reverting to \((lkg?["bundleId"] as? String) ?? "the embedded bundle", privacy: .public)")
        return lkg.flatMap { bundlePath($0) }
      }
      if !userReload { attempts += 1 }
      state["bootAttempts"] = attempts
      saveState(state)
      let notes = (forgiven ? " (previous launch refunded: reached JS then paused)" : "")
        + (userReload ? " (user reload, not counted)" : "")
      log.warning("launch: \((current["bundleId"] as? String) ?? "?", privacy: .public) on trial, attempt \(attempts, privacy: .public)/\(self.maxBootAttempts, privacy: .public)\(notes, privacy: .public)")
      return bundlePath(current)
    }
    saveState(state)
    log.warning("launch: \((current["bundleId"] as? String) ?? "?", privacy: .public) (healthy)")
    return bundlePath(current)
  }

  func currentMeta() -> [String: Any] {
    let current = slot(loadState(), "current")
    return [
      "bundleId": current?["bundleId"] as? String ?? "embedded",
      "bundleVersion": current?["version"] as? Int ?? 0,
      "isEmbedded": current == nil,
      // The server uses this to tell which bundle is running, so a delta can be built against it.
      "bundleSha256": current?["bundleSha256"] as? String ?? "",
    ]
  }

  /// True if a bundle was disabled by the crash-loop breaker.
  func isDisabled(_ bundleId: String) -> Bool {
    ((loadState()["disabledBundles"] as? [String]) ?? []).contains(bundleId)
  }

  /// Return + clear the bundleId most recently disabled by a crash-loop revert (report once).
  /// Return + clear the bundleId applied on this launch (report once).
  func consumeAppliedReport() -> String {
    var state = loadState()
    let applied = (state["appliedToReport"] as? String) ?? ""
    if !applied.isEmpty {
      state["appliedToReport"] = nil
      saveState(state)
    }
    return applied
  }

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

  /// Delete slot dirs no state key still references.
  ///
  /// The keep-set covers `pending` and `staged` too: keeping only current + last-known-good meant a
  /// bundle downloaded inside the health window was deleted by the `markHealthy` sweep before it
  /// could ever be applied.
  ///
  /// NEVER call this from the crash-loop branch — the bundle being demoted there is mapped by the
  /// process running it, and deleting its dir leaves the JS running with every require()d asset
  /// gone (the 2026-09-08 production incident).
  private func gc(_ state: [String: Any]) {
    // Keep-set by bundleId (stable across container migrations) — matching on stored absolute
    // paths would consider every live dir unknown after a migration and delete current + LKG.
    let keep = Set(
      ["current", "lastKnownGood", "pending", "staged"]
        .compactMap { slot(state, $0)?["bundleId"] as? String }
        .filter { !$0.isEmpty }
    )
    let dirs = (try? fm.contentsOfDirectory(at: bundlesDir, includingPropertiesForKeys: nil)) ?? []
    for d in dirs where !keep.contains(d.lastPathComponent) { try? fm.removeItem(at: d) }

    // Staging dirs for releases nobody references any more. Safe here and nowhere else: see the
    // call site in resolveBundleAtLaunch.
    let staged = (try? fm.contentsOfDirectory(at: stagingRoot, includingPropertiesForKeys: nil)) ?? []
    for d in staged where !keep.contains(d.lastPathComponent) { try? fm.removeItem(at: d) }
  }
}
