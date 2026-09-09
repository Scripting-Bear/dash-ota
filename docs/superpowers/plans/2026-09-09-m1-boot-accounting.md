# M1 — Boot accounting fix (react-native-dash-ota 0.3.2) Implementation Plan

> ## ✅ IMPLEMENTED 2026-09-09 — `253b165` plus the QA follow-up that moved the launch marks
>
> This plan is a historical record. **Do not re-execute it**: the shipped code differs from the
> listings below in three ways, all deliberate, all verified on device. Read
> `packages/rn/android/.../DashOtaStore.kt` and `packages/rn/ios/DashOtaStore.swift` for the truth.
>
> 1. **The launch marks live in their own `launch.json`, not in `state.json`.** The pause mark is
>    written from the main thread; a read-modify-write of the whole state from there can lose a
>    concurrent `markHealthy()` on the JS thread.
> 2. **The pause mark is cleared when the app returns to the foreground** (`onActivityResumed` /
>    `didBecomeActive`), so a pause/resume/crash is still counted and iOS transients are discarded.
> 3. **GC keeps `pending` and `staged` as well.** Keeping only current + last-known-good meant a
>    bundle downloaded inside the health window was deleted before it could be applied — a second
>    bug found while implementing.
>
> Verification actually run is recorded in the roadmap's Phase 1 evidence, not in Task 6 below.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a native-only release of `react-native-dash-ota` in which a healthy OTA bundle can never be blocklisted by repeated host calls or by users force-killing the app, and no slot directory is ever deleted underneath a running bundle.

**Architecture:** `DashOtaBundleLoader` memoises `resolveBundleAtLaunch` per process (already done). `DashOtaStore` gains a state schema tag, two per-launch marks (`launch.beaconAt`, `launch.pausedAt`) and a forgiveness rule that refunds the previous attempt when the previous process reached JS and was then paused by the user. GC moves to startup, before selection, and keeps every referenced slot.

**Tech Stack:** Kotlin (Android TurboModule), Swift + Obj-C++ (iOS TurboModule), org.json / Foundation JSON state file. No automated native test harness exists in this package; verification is the manual matrix in Task 6 using the go-trade app, the Android emulator and the iOS simulator.

**Spec:** `docs/superpowers/specs/2026-09-09-ota-v2-revamp-design.md` §4 (M1). Deviation recorded here: the "background" mark is written on `Activity.onPause` / `UIApplication.willResignActiveNotification`, not on stop/background, because an iOS swipe-kill from the app switcher only guarantees resign-active. The mark is named `pausedAt`.

## Global Constraints

- `MAX_BOOT_ATTEMPTS = 2` (two real crashes disable a bundle; the third launch reverts).
- State file: `<files>/dash-ota/state.json` (Android), `Application Support/dash-ota/state.json` (iOS). `stateSchema: 2`; any state without it is discarded on load.
- `gc()` may only run at startup before bundle selection or from `rollback()`. It keeps `current`, `lastKnownGood`, `pending`, `staged`.
- Never log tokens, keys, or file contents. Log lines use tag `DashOta` (Android) / `os_log` subsystem `dash-ota` (iOS), warning level, no PII.
- Version bump: `packages/rn/package.json` `0.3.1 → 0.3.2` (already applied in the working tree).
- Commits: one consolidated commit for the whole milestone at the end (Task 7). No `Co-authored-by` trailers.

---

### Task 1: Android — state schema tag and launch marks

**Files:**
- Modify: `packages/rn/android/src/main/java/com/dashota/DashOtaStore.kt` (`loadState`, `saveState`, new `markBeacon`, `markPaused`)

**Interfaces:**
- Produces: `DashOtaStore.markBeacon(ctx: Context)`, `DashOtaStore.markPaused(ctx: Context)`, `const val STATE_SCHEMA = 2`. State keys: `stateSchema: Int`, `launch: { beaconAt: Long, pausedAt: Long }`.

- [ ] **Step 1: Add the schema constant and discard pre-v2 state on load**

Replace the body of `loadState` so a state without `stateSchema == 2` is dropped:

```kotlin
  private const val STATE_SCHEMA = 2

  fun loadState(ctx: Context): JSONObject {
    val f = stateFile(ctx)
    if (!f.exists()) return JSONObject().put("stateSchema", STATE_SCHEMA)
    val parsed = try {
      JSONObject(f.readText())
    } catch (_: Exception) {
      JSONObject()
    }
    // Slots written by 0.3.x were staged by a loader that tripped the breaker on every first
    // boot; they are unusable, so a pre-schema-2 state is discarded rather than migrated.
    if (parsed.optInt("stateSchema", 1) != STATE_SCHEMA) {
      return JSONObject().put("stateSchema", STATE_SCHEMA)
    }
    return parsed
  }
```

Keep the existing atomic `saveState` (tmp + rename) but stamp the schema first:

```kotlin
  fun saveState(ctx: Context, state: JSONObject) {
    state.put("stateSchema", STATE_SCHEMA)
    val tmp = File(baseDir(ctx), "state.json.tmp")
    tmp.writeText(state.toString())
    if (!tmp.renameTo(stateFile(ctx))) {
      stateFile(ctx).writeText(state.toString())
    }
  }
```

- [ ] **Step 2: Add the two launch marks**

Add after `saveState`:

```kotlin
  /** JS initialised the module in this process — the bundle at least reached its runtime. */
  fun markBeacon(ctx: Context) = markLaunch(ctx, "beaconAt")

  /** The user left the app (Activity paused). A crash never writes this first. */
  fun markPaused(ctx: Context) = markLaunch(ctx, "pausedAt")

  private fun markLaunch(ctx: Context, key: String) {
    synchronized(this) {
      val state = loadState(ctx)
      val launch = state.optJSONObject("launch") ?: JSONObject()
      if (!launch.has(key)) {
        launch.put(key, System.currentTimeMillis())
        state.put("launch", launch)
        saveState(ctx, state)
      }
    }
  }
```

- [ ] **Step 3: Compile**

Run from the consuming app (the library has no standalone Android build):
```bash
cd /Users/essence/ReactNative/secure-ota/packages/rn && npm pack >/dev/null && \
cd /Users/essence/ReactNative/go-trade-mobile && npm install --no-save ../secure-ota/packages/rn/react-native-dash-ota-0.3.2.tgz >/dev/null && \
cd android && ./gradlew :react-native-dash-ota:compileReleaseKotlin --console=plain 2>&1 | grep -E 'BUILD|^e: ' 
```
Expected: `BUILD SUCCESSFUL`.

---

### Task 2: Android — forgiveness rule and startup GC

**Files:**
- Modify: `packages/rn/android/src/main/java/com/dashota/DashOtaStore.kt` (`resolveBundleAtLaunch`, `gc`, `rollback`)

**Interfaces:**
- Consumes: `launch` marks from Task 1.
- Produces: unchanged public signature `resolveBundleAtLaunch(ctx): String?`; `gc(ctx, state)` now takes the loaded state.

- [ ] **Step 1: Make GC keep every referenced slot and take the state as a parameter**

Replace `gc`:

```kotlin
  /**
   * Delete slot dirs no state key references. Only ever called at startup (before the bundle
   * is selected) or from rollback(); never from the crash-loop branch of a running process,
   * because the bundle being demoted may be memory-mapped by this very process.
   */
  private fun gc(ctx: Context, state: JSONObject) {
    val keep = listOf("current", "lastKnownGood", "pending", "staged")
      .mapNotNull { slot(state, it)?.optString("bundleId")?.takeIf { id -> id.isNotEmpty() } }
      .toSet()
    bundlesDir(ctx).listFiles()?.forEach { dir ->
      if (dir.name !in keep) dir.deleteRecursively()
    }
  }
```

Update the two existing call sites: in `rollback()` replace `gc(ctx)` with `gc(ctx, state)` (the local `state` there is already saved); in the crash-loop branch of `resolveBundleAtLaunch` **delete** the `gc(ctx)` line.

- [ ] **Step 2: Rewrite the trial branch of `resolveBundleAtLaunch`**

Replace the function body from `val userReload = …` down to the final `return bundlePath(ctx, current)` with:

```kotlin
    val userReload = state.optBoolean("userReload", false)
    if (userReload) state.remove("userReload")

    // Marks left by the PREVIOUS process. Reached JS and then paused by the user = not a crash.
    val prev = state.optJSONObject("launch")
    val forgiven = prev != null && prev.has("beaconAt") && prev.has("pausedAt")
    state.put("launch", JSONObject())

    // Startup GC: the only place slot dirs are deleted while nothing is mapped yet.
    gc(ctx, state)

    slot(state, "pending")?.let { pending ->
      state.put("current", pending)
      state.put("pending", JSONObject.NULL)
      state.put("trial", true)
      state.put("bootAttempts", 1)
      saveState(ctx, state)
      return bundlePath(ctx, pending)
    }

    val current = slot(state, "current") ?: run { saveState(ctx, state); return null }
    if (state.optBoolean("trial", false)) {
      var attempts = state.optInt("bootAttempts", 0)
      if (forgiven && attempts > 0) attempts -= 1 // refund the previous launch
      if (attempts >= MAX_BOOT_ATTEMPTS) {
        val failedId = current.optString("bundleId")
        val disabled = state.optJSONArray("disabledBundles") ?: JSONArray()
        if (failedId.isNotEmpty() && !jsonArrayContains(disabled, failedId)) disabled.put(failedId)
        state.put("disabledBundles", disabled)
        state.put("failedToReport", failedId)
        val lkg = slot(state, "lastKnownGood")
        state.put("current", lkg ?: JSONObject.NULL)
        state.put("trial", false)
        state.put("bootAttempts", 0)
        saveState(ctx, state)
        return lkg?.let { bundlePath(ctx, it) }
      }
      if (!userReload) attempts += 1
      state.put("bootAttempts", attempts)
      saveState(ctx, state)
      return bundlePath(ctx, current)
    }
    saveState(ctx, state)
    return bundlePath(ctx, current)
```

Trace to confirm the semantics before moving on:
- pending → launch 1: `bootAttempts = 1`, runs.
- crash in launch 1 → launch 2: not forgiven, `attempts = 1`, `1 >= 2` false, `attempts = 2`, runs.
- crash in launch 2 → launch 3: `attempts = 2 >= 2` → disabled, reverted. Two real crashes.
- user pause+kill after beacon in launch 1 → launch 2: forgiven, `attempts = 0`, runs with `1`. Repeatable forever.
- `markHealthy` in any launch sets `trial = false` → no accounting.

- [ ] **Step 3: Compile**

Same command as Task 1 Step 3. Expected: `BUILD SUCCESSFUL`.

---

### Task 3: Android — write the marks from the module

**Files:**
- Modify: `packages/rn/android/src/main/java/com/dashota/DashOtaModule.kt` (add `initialize()` override)

**Interfaces:**
- Consumes: `DashOtaStore.markBeacon`, `DashOtaStore.markPaused`.

- [ ] **Step 1: Add the lifecycle hook**

Add these imports:

```kotlin
import android.app.Activity
import android.app.Application
import android.os.Bundle
```

Add inside `class DashOtaModule`, before `getName()`:

```kotlin
  override fun initialize() {
    super.initialize()
    // The module is created lazily on first JS access, so reaching here proves the staged
    // bundle got as far as its runtime: the crash-loop breaker's "beacon".
    DashOtaStore.markBeacon(reactContext)
    val app = reactContext.applicationContext as? Application ?: return
    synchronized(DashOtaModule::class.java) {
      if (lifecycleRegistered) return
      lifecycleRegistered = true
    }
    app.registerActivityLifecycleCallbacks(object : Application.ActivityLifecycleCallbacks {
      override fun onActivityPaused(activity: Activity) = DashOtaStore.markPaused(reactContext)
      override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) = Unit
      override fun onActivityStarted(activity: Activity) = Unit
      override fun onActivityResumed(activity: Activity) = Unit
      override fun onActivityStopped(activity: Activity) = Unit
      override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) = Unit
      override fun onActivityDestroyed(activity: Activity) = Unit
    })
  }
```

Add to the `companion object`:

```kotlin
    @Volatile private var lifecycleRegistered = false
```

- [ ] **Step 2: Compile**

Same command as Task 1 Step 3. Expected: `BUILD SUCCESSFUL`.

---

### Task 4: iOS — schema tag, marks, forgiveness rule, startup GC

**Files:**
- Modify: `packages/rn/ios/DashOtaStore.swift` (`loadState`, `saveState`, new `markBeacon`/`markPaused`, `resolveBundleAtLaunch`, `gc`, `rollback`)
- Modify: `packages/rn/ios/DashOtaImpl.swift` (`init`)

**Interfaces:**
- Produces: `DashOtaStore.shared.markBeacon()`, `DashOtaStore.shared.markPaused()`; same state keys as Android (`stateSchema`, `launch.beaconAt`, `launch.pausedAt`).

- [ ] **Step 1: Schema tag on load/save**

```swift
  private let stateSchema = 2

  func loadState() -> [String: Any] {
    guard let data = try? Data(contentsOf: stateURL),
          let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
      return ["stateSchema": stateSchema]
    }
    // Pre-schema-2 slots came from a loader that tripped the breaker on every first boot.
    if (obj["stateSchema"] as? Int ?? 1) != stateSchema { return ["stateSchema": stateSchema] }
    return obj
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
```

- [ ] **Step 2: Launch marks**

```swift
  private let markLock = NSLock()

  func markBeacon() { markLaunch("beaconAt") }
  func markPaused() { markLaunch("pausedAt") }

  private func markLaunch(_ key: String) {
    markLock.lock(); defer { markLock.unlock() }
    var state = loadState()
    var launch = (state["launch"] as? [String: Any]) ?? [:]
    if launch[key] == nil {
      launch[key] = Int(Date().timeIntervalSince1970 * 1000)
      state["launch"] = launch
      saveState(state)
    }
  }
```

- [ ] **Step 3: GC keeps every referenced slot and takes the state**

```swift
  private func gc(_ state: [String: Any]) {
    let keep = Set(["current", "lastKnownGood", "pending", "staged"].compactMap {
      (slot(state, $0)?["bundleId"] as? String).flatMap { $0.isEmpty ? nil : $0 }
    })
    guard let dirs = try? fm.contentsOfDirectory(at: bundlesDir, includingPropertiesForKeys: nil) else { return }
    for dir in dirs where !keep.contains(dir.lastPathComponent) {
      try? fm.removeItem(at: dir)
    }
  }
```

In `rollback()` pass the saved state (`gc(state)`), in `dropIncompatibleSlots`'s caller pass `cleaned.state`, and remove the `gc()` call from the crash-loop branch.

- [ ] **Step 4: Rewrite the trial branch**

Replace from `let userReload = …` to the end of `resolveBundleAtLaunch` with:

```swift
    let userReload = (state["userReload"] as? Bool) == true
    if userReload { state["userReload"] = nil }

    let prev = state["launch"] as? [String: Any]
    let forgiven = prev?["beaconAt"] != nil && prev?["pausedAt"] != nil
    state["launch"] = [String: Any]()

    gc(state)

    if let pending = slot(state, "pending") {
      state["current"] = pending
      state["pending"] = nil
      state["trial"] = true
      state["bootAttempts"] = 1
      saveState(state)
      return bundlePath(pending)
    }
    guard let current = slot(state, "current") else { saveState(state); return nil }
    if (state["trial"] as? Bool) == true {
      var attempts = (state["bootAttempts"] as? Int) ?? 0
      if forgiven && attempts > 0 { attempts -= 1 }
      if attempts >= maxBootAttempts {
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
        return lkg.flatMap { bundlePath($0) }
      }
      if !userReload { attempts += 1 }
      state["bootAttempts"] = attempts
      saveState(state)
      return bundlePath(current)
    }
    saveState(state)
    return bundlePath(current)
```

- [ ] **Step 5: Write the marks from the module**

In `DashOtaImpl.swift` add `import UIKit` and an initializer:

```swift
  private var pauseObserver: NSObjectProtocol?

  public override init() {
    super.init()
    DashOtaStore.shared.markBeacon()
    // willResignActive fires on every backgrounding and on app-switcher kills; a crash never does.
    pauseObserver = NotificationCenter.default.addObserver(
      forName: UIApplication.willResignActiveNotification, object: nil, queue: nil
    ) { _ in DashOtaStore.shared.markPaused() }
  }

  deinit {
    if let o = pauseObserver { NotificationCenter.default.removeObserver(o) }
  }
```

- [ ] **Step 6: Compile**

```bash
cd /Users/essence/ReactNative/secure-ota/packages/rn && npm pack >/dev/null && \
cd /Users/essence/ReactNative/go-trade-mobile && npm install --no-save ../secure-ota/packages/rn/react-native-dash-ota-0.3.2.tgz >/dev/null && \
cd ios && pod install >/dev/null && \
set -o pipefail && xcodebuild -workspace gotradeindia.xcworkspace -scheme GoTradeIndia-Dev -configuration Release-Dev -sdk iphonesimulator -destination 'id=9915BA1E-C733-47B6-A599-EE1219AE0D05' -derivedDataPath /tmp/dash-ota-m1-dd build 2>&1 | grep -E 'BUILD (SUCCEEDED|FAILED)|error:' | tail -5
```
Expected: one `** BUILD SUCCEEDED **` for the app target (the CMake sub-build may print its own; the last line must be SUCCEEDED and no `error:` lines).

---

### Task 5: Docs and changelog for 0.3.2

**Files:**
- Modify: `website/docs/concepts/crash-loop.md`
- Modify: `website/docs/architecture/slot-model.md`
- Modify: `website/docs/react-native/troubleshooting.md`
- Modify: `packages/rn/CHANGELOG.md` (create if absent)

- [ ] **Step 1: crash-loop.md — replace the attempt-counting paragraph**

Append a section:

```markdown
## What counts as a boot attempt (0.3.2+)

The bundle resolver runs **once per process** (React Native reads `getJSBundleFile()` /
`bundleURL()` several times per launch; earlier versions counted each read as an attempt and
disabled every bundle on its first boot).

An attempt is spent when a trial bundle is selected at launch. It is **refunded** at the next
launch if the previous process both reached JS (the module initialised — the *beacon*) and was
then paused by the user (`Activity.onPause` / `willResignActive`). A crash never writes the pause
mark first, so crashes before *and* after JS init still count. Two real crashes disable a bundle;
force-killing the app any number of times does not.
```

- [ ] **Step 2: slot-model.md — document state schema 2**

Append:

```markdown
## State schema 2

`state.json` carries `stateSchema: 2`. A state file without it is discarded on load (the embedded
bundle runs and the next check re-downloads). Per-launch marks live under `launch`:
`{ beaconAt, pausedAt }` (epoch ms), reset by the resolver at every launch.

GC runs only at startup, before the bundle is selected, and keeps every slot referenced by
`current`, `lastKnownGood`, `pending` or `staged`. Nothing is deleted from a running process.
```

- [ ] **Step 3: troubleshooting.md — add the symptom**

Append:

```markdown
## All bundled images disappear right after an update applies

Symptom: the new bundle runs, every `require()`d image is blank (`ENOENT` for
`…/bundles/<id>/drawable-*/…` or `…/assets/…` in the native log), and the next launch reverts to
the previous bundle with `adoption.failed` incremented on the server.

Cause: `react-native-dash-ota` < 0.3.2 counted every host read of the bundle path as a boot
attempt, tripped the crash-loop breaker on the first boot and deleted the slot directory while
the bytecode was still mapped. Fix: upgrade to 0.3.2 or later (native change — requires a store
release).
```

- [ ] **Step 4: CHANGELOG entry**

```markdown
## react-native-dash-ota 0.3.2

- fix: resolve the OTA bundle once per process; React Native re-reads the bundle path 5–6× per
  launch and each read used to spend a crash-loop attempt, disabling every bundle on first boot
  and deleting its slot under the running app (all images ENOENT).
- fix: boot attempts are refunded when the previous process reached JS and was paused by the
  user, so force-kills never blocklist a healthy bundle.
- fix: GC runs only at startup and keeps every referenced slot.
- breaking (state): `state.json` gains `stateSchema: 2`; older state is discarded on load.
```

---

### Task 6: Manual verification matrix (Android emulator + iOS simulator)

**Files:** none. Uses the go-trade app with the local tarball installed (Task 4 Step 6 leaves it installed).

Prerequisites: emulator `Medium_Phone_API_36.1` booted (`adb devices` shows `emulator-5554`), iOS simulator `iPhone 17 Pro` (`9915BA1E-C733-47B6-A599-EE1219AE0D05`) booted, `.env.dev` OTA config pointing at the UAT ota server.

- [ ] **Step 1: Build and fresh-install Android**

```bash
cd /Users/essence/ReactNative/go-trade-mobile/android && ./gradlew assembleDevRelease -PreactNativeArchitectures=arm64-v8a --console=plain 2>&1 | grep -E 'BUILD' && \
adb uninstall com.kksl.gotradeindia.development; adb install app/build/outputs/apk/dev/release/app-dev-release.apk
```

- [ ] **Step 2: Publish a mandatory dev release (auto-downloads without login)**

```bash
cd /Users/essence/ReactNative/go-trade-mobile && node scripts/dash-ota-publish.mjs --variant dev --platform both --rollout 100 --mandatory --release-note "m1 verification" 2>&1 | grep -E 'bundleId|published|done'
```

- [ ] **Step 3: Android — stage, apply, confirm healthy**

```bash
PKG=com.kksl.gotradeindia.development; adb logcat -c; adb shell monkey -p $PKG -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1
for i in $(seq 1 30); do sleep 4; adb logcat -d | grep -q 'status: apply-pending' && break; done
adb shell am force-stop $PKG; adb logcat -c; adb shell monkey -p $PKG -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1; sleep 14
adb logcat -d | grep -E 'dash-ota\]' | head; echo "image errors: $(adb logcat -d | grep -cE 'ENOENT|Load failed')"
```
Expected: `status: up-to-date`, `image errors: 0`, and `node scripts/dash-ota-list.mjs --variant dev` shows `healthy: 1` for the new Android bundle.

- [ ] **Step 4: Android — force-kill forgiveness**

Immediately after a cold launch (within 5 s, before health): press Home, then swipe the app away from recents. Repeat three times. Then launch normally and wait 15 s.
```bash
adb logcat -d | grep -E 'reporting crash-loop|skipping disabled'
```
Expected: no output (bundle not disabled), status `up-to-date`.

- [ ] **Step 5: Android — real crash loop still caught**

Publish a dev release whose `index.js` throws at module scope (`throw new Error('m1 crash test')` as the first line), mandatory, let it stage, then cold-start the app three times, waiting for the crash each time.
```bash
adb logcat -d | grep -E 'reporting crash-loop failure'
```
Expected: one line on the third launch; the app is running the previous bundle; server shows `failed: 1`. Roll the crash release back afterwards:
```bash
npx dash-ota rollback --bundle-id <id> --server "$OTA_SERVER_URL"
```

- [ ] **Step 6: iOS — apply and inspect state**

```bash
S=/tmp/dash-ota-m1-dd/Build/Products/Release-Dev-iphonesimulator/GoTradeIndia.app; BID=com.kksl.gotradeindia.development
xcrun simctl terminate booted $BID 2>/dev/null; xcrun simctl install booted "$S"; C=$(xcrun simctl get_app_container booted $BID data)
rm -rf "$C/Library/Application Support/dash-ota"; xcrun simctl launch booted $BID
sleep 40; xcrun simctl terminate booted $BID; xcrun simctl launch booted $BID; sleep 14
python3 -c "import json;s=json.load(open('$C/Library/Application Support/dash-ota/state.json'));print({k:(s.get(k) or {}).get('bundleId') if isinstance(s.get(k),dict) else s.get(k) for k in ('stateSchema','current','lastKnownGood','trial','bootAttempts','disabledBundles','launch')})"
```
Expected: `stateSchema 2`, `current == lastKnownGood == <new ios bundleId>`, `trial False`, `bootAttempts 0`, `disabledBundles None`, `launch` has `beaconAt`.

- [ ] **Step 7: iOS — forgiveness**

Cold-launch, within 5 s press Home (`xcrun simctl` cannot; use the simulator UI), swipe-kill from the app switcher, repeat three times, relaunch, wait 15 s, re-run the Python line from Step 6. Expected: `disabledBundles None`.

- [ ] **Step 8: Roll back the verification releases on the dev channel**

```bash
npx dash-ota rollback --bundle-id <android id> --server "$OTA_SERVER_URL"; npx dash-ota rollback --bundle-id <ios id> --server "$OTA_SERVER_URL"
```

---

### Task 7: Commit

- [ ] **Step 1: Review the diff**

```bash
cd /Users/essence/ReactNative/secure-ota && git status --short && git diff --stat
```
Expected files: the two loaders, both stores, `DashOtaModule.kt`, `DashOtaImpl.swift`, `packages/rn/package.json`, `packages/rn/CHANGELOG.md`, three docs pages. Exclude `package-lock.json` unless it only reflects the version bump.

- [ ] **Step 2: Commit**

```bash
git add packages/rn/android/src/main/java/com/dashota/DashOtaBundleLoader.kt packages/rn/android/src/main/java/com/dashota/DashOtaStore.kt packages/rn/android/src/main/java/com/dashota/DashOtaModule.kt packages/rn/ios/DashOtaBundleLoader.swift packages/rn/ios/DashOtaStore.swift packages/rn/ios/DashOtaImpl.swift packages/rn/package.json packages/rn/CHANGELOG.md website/docs/concepts/crash-loop.md website/docs/architecture/slot-model.md website/docs/react-native/troubleshooting.md
git commit -m "fix(rn): resolve the bundle once per process and stop the breaker deleting live slots (0.3.2)

React Native reads getJSBundleFile()/bundleURL() 5-6 times per launch; each read
spent a crash-loop attempt, so every bundle was disabled on its first boot and its
slot directory deleted under the mapped bytecode (all images ENOENT, update reverted).

- memoise the resolver per process on both platforms
- refund an attempt when the previous process reached JS and was paused by the user
- GC only at startup, keeping every referenced slot
- state schema 2; pre-0.3.2 state is discarded"
```
