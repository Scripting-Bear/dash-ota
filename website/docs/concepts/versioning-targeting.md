---
sidebar_position: 3
title: Versioning & targeting
description: runtimeVersion, bundleVersion, channels, targetAppVersions and rollout, and how they keep an update off a binary it can't run on.
---

# Versioning & targeting

Which release reaches which device is decided by two identifiers every release has, plus a few
optional filters. The server applies all of them when it picks a release; the device checks the
signed ones again before it installs anything.

## The two identifiers

### `runtimeVersion`: which binaries a release can run on

A string that names a native build: its native code, native dependencies, React Native and Hermes
versions. The app embeds it (Android resource `ota_runtime_version`, iOS `OTA_RUNTIME_VERSION`), and
every release carries one. A device only installs a release whose `runtimeVersion` equals its own,
exactly.

You choose how it's made:

- **A fixed string you change by hand**, such as `rt1`, then `rt2` when native code changes. Simple
  and predictable. The risk is forgetting to change it.
- **`--runtime-version auto`**: the CLI computes a hash of your `package.json` dependencies, the
  React Native and Hermes versions, and the git-tracked files under `android/` and `ios/`
  (`npx dash-ota fingerprint` prints it). It changes whenever any of those change, including a
  JavaScript-only dependency, so it changes more often than strictly necessary. The app has to
  embed the same value, so you'd generate it during the store build too.

### `bundleVersion`: the order of releases

A whole number that must go up with every release on a channel. The device refuses a release whose
`bundleVersion` isn't higher than the bundle it runs now (the embedded bundle counts as 0).

That check compares with the running bundle only; nothing is remembered between bundles. After a
store update, a `rollback()` or a crash-loop revert, the device runs a lower version, so an older
release can be accepted again if the server offers it.

## Optional filters

| Filter | Set with | Checked by |
|---|---|---|
| `channel` (dev / uat / prod) | the app's build flavour; `--channel` on publish | server; device from 0.5.1 |
| `platform` | `--platform` on publish | server; device from 0.5.1 |
| `targetAppVersions` | `--target-app-versions ">=1.2.0 <1.3.0"` | server only |
| `minNativeBuild` | `--min-native-build <n>` | server; device from 0.5.1 |
| rollout percentage | `--rollout` on publish, `rollout --pct` later | server only |

`targetAppVersions` is a semver range over your app's marketing version (`appVersion` in the
provider config). The rollout percentage uses a bucket from 0 to 99 per device and release, computed
from the install id and the `bundleId`: a device doesn't flip in and out between checks, and each
release picks a different group.

## How the server picks

On each check, the server looks at every finalized release that isn't paused or rolled back and
keeps the ones where:

- channel and platform match the device,
- `runtimeVersion` matches exactly,
- `bundleVersion` is higher than the device's current one,
- the device's native build is at least `minNativeBuild`, if set,
- the device's app version is inside `targetAppVersions`, if set,
- the device's bucket is below the rollout percentage.

Of those, it offers the one with the highest `bundleVersion`, or nothing. So a device outside the
newest release's rollout can still be offered an older release that it's eligible for.

## Store builds and updates

The classic mistake: a JavaScript update written for a new store build reaches devices still on the
old one, calls native code that isn't there, and crashes. A new runtime version per native build
prevents it:

| Step | runtimeVersion | Result |
|---|---|---|
| Users install store build 1 | `rt1` | those devices only take `rt1` releases |
| Native changes ship as store build 2 | `rt2` | build 2 devices only take `rt2` releases |
| A JS fix is published with `--runtime-version rt2` | `rt2` | offered to build 2 devices only |
| A build 1 device checks in | `rt1` | not offered the `rt2` release |
| The same fix is also published with `--runtime-version rt1` | `rt1` | build 1 devices get it |

Each native build gets its own line of releases, and an update can't reach a binary it wasn't
published for, as long as the runtime version changes with every native change. If you ship a new
store build without changing it, the new build and the old one share a line: releases meant for
either reach both, and after the store update the device runs the embedded bundle (version 0) and is
offered the latest release for that runtime version, which may be older code than the new build.
`--min-native-build` keeps a release off older builds, but only a new runtime version keeps older
releases off a newer build.

→ [Environments](/docs/react-native/environments) · [Staged rollouts](/docs/guides/staged-rollout)
