---
sidebar_position: 4
title: Slot model & atomic apply
---

# Slot model & atomic apply

Bundles live in on-disk **slots**. A slot only exists once every file in it has been verified, so
a process killed mid-download or mid-commit never leaves a half-written bundle to boot.

## Slots

| Slot | What |
|---|---|
| `current` | the bundle the app boots from now |
| `lastKnownGood` | the last bundle that called `markHealthy()` |
| `staged` | a downloaded, verified bundle |
| `pending` | a staged bundle promoted by `applyOnNextLaunch`, which becomes `current` at the next launch |
| (embedded) | the bundle shipped in the binary — the ultimate fallback |

Plus boot-attempt counters and a `disabledBundles` list (crash-loop breaker).

## Atomic apply

Files are assembled in a staging directory, each written to a temporary name and renamed into place
only after its hash checks out. The staging directory is then renamed to the slot directory, and
only after that is the slot recorded in `state.json`. The state file is written to a temporary file
and renamed over the old one (on Android, a failed rename falls back to a direct write; on iOS the
write is atomic from 0.5.1). Nothing is `fsync`ed, and there is no separate commit marker.

A pending bundle becomes current only when a bundle is loaded: at the next cold start, or when the
app calls `applyUpdate(true)`, which reloads in-process on iOS and relaunches the process on
Android. Running JS is never patched in place.

## Which bundle boots

The native `getBundleFile()` (Android) / `bundleURL()` (iOS) hook returns the active slot's path, or
`null`/the embedded path as a fallback. This runs **before** React starts, so the choice of bundle
is made by trusted native code, not JS.

## Cleanup & retention

- **GC:** runs at launch, before the bundle is chosen. It keeps every slot the state references —
  `current`, `lastKnownGood`, `pending` and `staged` — and deletes other slot and staging
  directories.
- **Store-update reset:** each slot records the `runtimeVersion` and native build number it was
  staged under. When a store update changes either, native drops every stored slot at the next
  launch and boots the embedded bundle. This does not stop the server offering an older OTA again:
  the device now runs version 0, so any release for the same `runtimeVersion` is newer to it.
  Change `runtimeVersion` with each store build, or publish the store build's JS as an OTA with
  `--min-native-build <N>` so it outranks older releases on the new binary. Only the
  `runtimeVersion` change also holds against a [breached server](/docs/security/breach). See
  [Versioning](/docs/concepts/versioning-targeting).
- **No free-space pre-check:** a download that runs out of disk fails, and the running bundle is
  left alone.

→ [Lifecycle](/docs/concepts/lifecycle) · [Crash-loop breaker](/docs/concepts/crash-loop)

## State schema 2 (0.4.0 and later)

`state.json` carries `stateSchema: 2`. A state file without it is discarded on load: the embedded
bundle runs and the next check re-downloads. Slots written before schema 2 came from a resolver that
disabled them on their first boot, so they are not worth migrating.

Per-launch marks live in their **own** file, `launch.json`, as `{ beaconAt, pausedAt }` (epoch
milliseconds). The resolver consumes and deletes it at every launch. They drive attempt forgiveness
in the [crash-loop breaker](/docs/concepts/crash-loop).

They are deliberately not part of `state.json`: the pause mark is written from the main thread by a
lifecycle callback, and a read-modify-write of the whole state from there could lose a concurrent
`markHealthy()` on the JS thread. An unreadable `launch.json` is treated as no marks, which counts
the launch rather than forgiving it.

GC keeps every slot the state still references — `current`, `lastKnownGood`, `pending` **and**
`staged` — and runs at startup before the bundle is selected. Two rules follow from that:

- A bundle downloaded inside the health window is no longer swept away before it can be applied.
- The crash-loop branch never deletes anything. The bundle it demotes is memory-mapped by the
  process that is running it.
