# react-native-dash-ota

## 0.5.1

Fixes an iOS crash introduced in 0.5.0 and closes the gaps a review of the client turned up. No
API changes; the native changes need a new store build, like any native update.

- **fix (iOS, crash):** 0.5.0 subscribed to download progress through `NativeEventEmitter` on both
  platforms, but the iOS module did not implement `addListener`/`removeListeners`, so starting a
  download raised an unrecognized-selector exception. iOS now implements both as no-ops, and the
  client only subscribes on Android, where the event exists.
- **fix (iOS):** `applyUpdate(true)` reloaded the old bundle. The bundle loader resolves once per
  process, and a reload is the same process; the restart now clears that cache first.
- **fix (iOS):** rejections carried a generic "The operation couldn't be completed" message instead
  of the real reason, such as `manifest signature did not verify`. That also stopped the automatic
  re-check after an expired download token from ever firing on iOS.
- **security:** native code now rejects a signed manifest whose `channel` or `platform` differs from
  the binary's, or whose `minNativeBuild` is above the installed build. The server already filters
  on these; the device checks them too, so a breached server cannot hand one channel's release to
  another channel that trusts the same key. `bundleId` and every file hash are checked for safe
  characters before they are used as file names.
- **fix:** an update announced as mandatory kept `isMandatory` and `ui.blocking` set after its
  download or verification failed, which could leave a blocking screen up with nothing to install.
  An announcement is unverified until native checks the signature, so it now stops blocking when
  the download fails or the bundle is disabled. A verified, staged mandatory bundle still blocks.
- **fix:** the `healthy` report was never sent when `markHealthy()` ran on mount, before the first
  check had loaded the current bundle. It is now sent after the next check.
- **fix:** if the last-known-good bundle also crash-loops after a revert, the device now falls back
  to the embedded bundle. Previously the fallback ran without the breaker watching it.
- **fix (iOS):** the slot state file is written atomically.
- **fix:** a check response without `nativePolicy` no longer throws.
- **package:** repository links point at the real repository, `peerDependencies` states the React
  Native 0.79 floor, and Android unit tests are no longer published.

## 0.5.0

Closes a hole in the force-update gate: the policy that drives it is not covered by the manifest
signature, so the store link it carried was whatever the update server said.

- **breaking (behaviour):** `nativePolicy.storeUrl` is now **your** `config.storeUrl`, and a value
  from the server is dropped rather than passed through. A scheme check cannot tell your listing
  from `https://attacker.example`, and the gate that opens it is a blocking, full-screen prompt on
  every install — so the destination is no longer something the network gets to choose.

  **If you relied on the server's `storeUrl`, set `config.storeUrl` or your gate loses its link.**
  Accepted schemes are `https://`, `market://` and `itms-apps://`; anything else is refused and
  logged. A dropped server value is logged too, so the cause is visible in a release build.

- **fix:** `BundleMeta.bundleSha256` is populated on both platforms. It was declared non-optional
  but never sent, so `/check` always reported an empty current-bundle hash and the server could
  not tell which bundle a device was running. Both platforms already stored the value; the meta
  readers just dropped it.

- **new:** download progress is reported while a bundle downloads. The client now subscribes to
  the native `onDashOtaProgress` event, so `ui.progress` moves through 0–1 instead of jumping from
  `null` to `1`. **Android only** — iOS does not emit the event yet, so `ui.progress` stays `null`
  there and a spinner is still the right thing to render for `null`.

- **note:** `severity` and `minSupportedNativeVersion` are still unsigned. A breached update server
  can still hold every install behind a blocking gate — it just cannot say where the button goes.
  Signing the policy is a protocol change and is on the roadmap rather than in this release.

## 0.4.1

Fixes OTA downloads failing in minified release builds, and only there.

- **fix:** the zstd-jni keep rule ships from the library as a consumer ProGuard file. R8 renames
  `ZstdInputStreamNoFinalizer`'s private `srcPos`/`dstPos`, which zstd-jni's native
  `decompressStream` resolves by name through `GetFieldID`. The AGP default rule keeps class and
  native method names only, and does not match a class with no native methods at all. zstd-jni
  ships no consumer rules of its own, so every download failed once minification was on. No
  consumer needs an app-level rule.

## 0.4.0

Protocol 2. Releases are now per-file content-addressed blobs instead of one archive, so an
unchanged file is stored and transferred once across every release that contains it.

- **new:** per-file content-addressed blobs, zstd compression, and AES-256-GCM with the plaintext
  hash bound in as AAD (manifest schema 2).
- **new:** both platforms fetch blob by blob, reuse files already present in the current or
  last-known-good slot by hard link, and resume interrupted downloads with a byte range.
- **new:** decompression is bounded at the size declared in the manifest, so a hostile blob cannot
  expand without limit.
- **fix:** adoption telemetry was half-wired — the client only ever reported `healthy` and
  `failed`, so `applied` and `rolled_back` stayed at zero. A release that applied everywhere and
  then crashed everywhere showed no adoption rather than a cliff. Only the launch that promotes a
  pending bundle knows it happened, so it is now recorded natively at the swap and consumed once.
  `rollback()` reports `rolled_back` for the bundle being left, which also feeds the server's
  auto-pause failure rate.
- **fix:** `markHealthy()` no longer deletes a download that is still in progress.
- **fix:** the vendored zstd on iOS is symbol-prefixed, so a host app's own libzstd cannot hijack
  it.
- **breaking:** the client speaks `/ota/v2/*` only. A 0.4 app against a v1 backend gets a hard
  update policy and no releases; the v1 routes are tombstones that return 410.

## 0.3.2

Never published to npm: the next release on npm after 0.3.1 is 0.4.0, which includes these fixes.

Fixes a bug that made every OTA update appear to apply, lose all of its bundled images, and then
revert on the next launch.

- **fix:** resolve the OTA bundle **once per process**. React Native re-reads the bundle path five
  or six times per launch, and each read used to spend a crash-loop boot attempt — so the breaker
  disabled every bundle on its first boot and deleted its slot directory underneath the running,
  memory-mapped bytecode. Every `require()`d asset then failed with ENOENT.
- **fix:** boot attempts are **refunded** when the previous process reached JS and was then paused
  by the user, so force-killing the app can no longer blocklist a healthy bundle. Real crashes,
  before or after JS starts, still count. Returning to the foreground clears the pause mark, so a
  bundle that pauses, resumes and then crashes is not forgiven.
- **fix:** GC keeps every slot the state references, including `pending` and `staged`. A bundle
  downloaded inside the health window used to be deleted before it could be applied.
- **fix:** the crash-loop branch no longer deletes slot directories from a live process.
- **new:** the launch decision is logged natively, one line per cold start (Android `adb logcat -s
  DashOta:W`, iOS subsystem `dash-ota`). Release builds strip the JS console trail, so this is the
  only way to see why an update did or did not apply on a real device. No tokens, keys or user data.
- **breaking (on-disk state):** `state.json` gains `stateSchema: 2`; older state is discarded on
  load. The embedded bundle runs and the next check re-downloads.
