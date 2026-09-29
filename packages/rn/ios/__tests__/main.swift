// Swift tests for the iOS slot state machine — the twin of DashOtaStoreTest.kt.
//
// There is no Xcode test target: the sources are compiled into a host app by CocoaPods, and adding
// an XCTest target to a generated project is fragile. `DashOtaStore` needs only Foundation and os,
// so this compiles it for the host platform and drives it directly. Each case runs against a fresh
// `Application Support` because the runner sets HOME to a temp directory — no test-only hooks in
// production code.
//
// Run: `npm run test:ios`.

import Foundation

var failures = 0
var passed = 0

/// Assert, recording rather than aborting, so one failure does not hide the rest.
func check(_ name: String, _ body: () throws -> Void) {
    // A fresh state directory per case, mirroring the Kotlin @Before.
    let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("dash-ota")
    try? FileManager.default.removeItem(at: base)
    do {
        try body()
        passed += 1
        print("  ✓ \(name)")
    } catch {
        failures += 1
        print("  ✗ \(name)\n      \(error)")
    }
}

struct Failed: Error, CustomStringConvertible {
    let description: String
    init(_ message: String) { description = message }
}

func expect(_ condition: Bool, _ message: String) throws {
    if !condition { throw Failed(message) }
}

func expectEqual<T: Equatable>(_ actual: T, _ expected: T, _ message: String) throws {
    if actual != expected { throw Failed("\(message) — expected \(expected), got \(actual)") }
}

let store = DashOtaStore.shared

/// Assemble a bundle in staging and commit it: what a completed download does.
@discardableResult
func stage(_ bundleId: String, _ version: Int, files: [String: String] = ["main.jsbundle": "sha-bundle"]) throws -> URL {
    let staging = store.stagingDir(bundleId)
    for path in files.keys {
        let url = staging.appendingPathComponent(path)
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try "// \(bundleId)".write(to: url, atomically: true, encoding: .utf8)
    }
    try store.commitStaged(
        bundleId: bundleId, version: version, runtimeVersion: DashOtaConfig.runtimeVersion,
        bundleSha256: "sha-bundle", files: files
    )
    return staging
}

print("\ndash-ota iOS store\n")

check("a fresh install resolves to the embedded bundle") {
    try expect(store.resolveBundleAtLaunch() == nil, "a fresh install must fall back to the embedded bundle")
}

check("a pending bundle applies on trial and can be marked healthy") {
    try stage("bnd_1", 1)
    try expect(store.promoteStagedToPending(), "staged should promote to pending")
    let path = store.resolveBundleAtLaunch()
    try expect(path != nil, "the pending bundle should now be current")
    let state = store.loadState()
    try expect(state["trial"] as? Bool == true, "a freshly applied bundle runs on trial")
    store.markHealthy()
    try expect(store.loadState()["trial"] as? Bool == false, "marking healthy ends the trial")
}

check("two real crashes disable the bundle and revert to the embedded one") {
    try stage("bnd_1", 1)
    _ = store.promoteStagedToPending()
    _ = store.resolveBundleAtLaunch()          // attempt 1
    _ = store.resolveBundleAtLaunch()          // attempt 2
    let third = store.resolveBundleAtLaunch()  // breaker trips
    try expect(third == nil, "after MAX_BOOT_ATTEMPTS the bundle must be abandoned")
    try expect(store.isDisabled("bnd_1"), "the crashing bundle must be blocklisted")
    try expectEqual(store.consumeFailedReport(), "bnd_1", "the failure must be reportable exactly once")
    try expectEqual(store.consumeFailedReport(), "", "and only once")
}

check("a last-known-good that also crash-loops falls back to the embedded bundle") {
    try stage("bnd_good", 1)
    _ = store.promoteStagedToPending()
    _ = store.resolveBundleAtLaunch()
    store.markHealthy()
    try stage("bnd_bad", 2)
    _ = store.promoteStagedToPending()
    _ = store.resolveBundleAtLaunch()             // bnd_bad, attempt 1
    _ = store.resolveBundleAtLaunch()             // attempt 2
    let reverted = store.resolveBundleAtLaunch()  // breaker: back to bnd_good
    try expect(reverted != nil, "the first revert lands on the last-known-good bundle")
    try expect(store.loadState()["trial"] as? Bool == true, "the fallback runs on trial")
    _ = store.resolveBundleAtLaunch()             // bnd_good, attempt 2
    let last = store.resolveBundleAtLaunch()      // breaker again
    try expect(last == nil, "a fallback that also loops must end on the embedded bundle")
    try expect(store.isDisabled("bnd_good"), "the fallback is blocklisted too")
}

check("force killing the app never disables a healthy bundle") {
    try stage("bnd_1", 1)
    _ = store.promoteStagedToPending()
    for _ in 0..<10 {
        _ = store.resolveBundleAtLaunch()
        // What a user swiping the app away looks like: JS ran, then the app resigned active.
        store.markBeacon()
        store.markPaused()
    }
    try expect(!store.isDisabled("bnd_1"), "a force-kill is not a crash and must never disable a bundle")
}

check("a bundle that reaches JS, resumes, and then crashes is still counted") {
    try stage("bnd_1", 1)
    _ = store.promoteStagedToPending()
    for _ in 0..<3 {
        _ = store.resolveBundleAtLaunch()
        store.markBeacon()
        store.markPaused()
        store.clearPaused()   // came back to the foreground, so the pause is not a real exit
    }
    try expect(store.isDisabled("bnd_1"), "resuming clears the pause, so these launches count as crashes")
}

check("an apply is reported exactly once, on the launch that performed it") {
    try stage("bnd_1", 1)
    _ = store.promoteStagedToPending()
    try expectEqual(store.consumeAppliedReport(), "", "nothing applied yet")
    _ = store.resolveBundleAtLaunch()
    try expectEqual(store.consumeAppliedReport(), "bnd_1", "the launch that applied it must report it")
    try expectEqual(store.consumeAppliedReport(), "", "and must not report twice")
    _ = store.resolveBundleAtLaunch()
    try expectEqual(store.consumeAppliedReport(), "", "a later launch must not re-report")
}

check("marking healthy never touches a download in progress") {
    try stage("bnd_1", 1)
    _ = store.promoteStagedToPending()
    _ = store.resolveBundleAtLaunch()
    store.markHealthy()

    // A second update begins: its staging directory exists but nothing references it yet, because
    // `staged` is only written at commit time.
    let staging = store.stagingDir("bnd_2")
    let asset = staging.appendingPathComponent("assets/logo.png")
    try? FileManager.default.createDirectory(at: asset.deletingLastPathComponent(), withIntermediateDirectories: true)
    try "reused asset bytes".write(to: asset, atomically: true, encoding: .utf8)

    store.markHealthy()   // the host app does this on a timer, mid-download
    try expect(
        FileManager.default.fileExists(atPath: asset.path),
        "marking healthy deleted a staging directory belonging to an in-flight download"
    )
}

check("a slot is never published while a promised file is missing") {
    let staging = store.stagingDir("bnd_partial")
    try "// bundle".write(to: staging.appendingPathComponent("main.jsbundle"), atomically: true, encoding: .utf8)
    var threw = false
    do {
        try store.commitStaged(
            bundleId: "bnd_partial", version: 1, runtimeVersion: DashOtaConfig.runtimeVersion,
            bundleSha256: "sha-bundle",
            files: ["main.jsbundle": "sha-bundle", "assets/logo.png": "sha-logo"]
        )
    } catch {
        threw = true
    }
    try expect(threw, "committing an incomplete slot must fail loudly")
    try expect(store.loadState()["staged"] == nil, "a rejected commit must not become the staged slot")
}

check("a committed slot advertises its files for the next update to reuse") {
    try stage("bnd_1", 1, files: ["main.jsbundle": "sha-bundle", "assets/logo.png": "sha-logo"])
    _ = store.promoteStagedToPending()
    _ = store.resolveBundleAtLaunch()
    let have = store.haveFiles()
    try expect(have["sha-logo"] != nil, "a file in the current slot must be offered for reuse")
    try expect(have["sha-bundle"] != nil, "including the bundle itself")
}

check("a corrupt state file does not brick OTA forever") {
    try stage("bnd_1", 1)
    let stateURL = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("dash-ota/state.json")
    try "{ not json".write(to: stateURL, atomically: true, encoding: .utf8)
    // Must fall back to a clean state rather than throwing on every read.
    _ = store.resolveBundleAtLaunch()
    try expect(store.loadState()["current"] == nil, "a corrupt state must be discarded, not trusted")
}

print("\n\(passed) iOS store checks passed\(failures > 0 ? ", \(failures) FAILED" : "").\n")
exit(failures == 0 ? 0 : 1)
