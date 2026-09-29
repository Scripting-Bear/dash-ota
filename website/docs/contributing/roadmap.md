---
sidebar_position: 2
title: Roadmap
---

# Roadmap

What is not built yet, and why it hasn't blocked anything so far.

## Not built

**Source-map upload from `publish`.** Nothing in the CLI touches source maps today, so symbolicating
a crash in an OTA bundle means uploading the map to Crashlytics or Sentry yourself, keyed by the
debug id. Folding it into `dash-ota publish` would remove a manual step from every release.

**Differential patches.** The manifest format already carries them — `patches: PatchEntry[]` is
part of schema 2, validated, and the blob resolver honours it. Nothing generates them. The client
side is ready: `BundleMeta.bundleSha256` is now populated on both platforms, so `/check` tells the
server exactly which bundle is running and what a delta would have to apply against. What is
missing is the producer in the CLI and the matching selection logic in the backend.

**A first-party Fastify or Koa adapter.** Both work today by bridging the Connect-style middleware
through `@fastify/middie` or `koa-connect`, which is documented and takes three lines. A dedicated
adapter package would only save those three lines, so it has stayed low priority.

**Xcode scheme and config generators for iOS.** The per-flavour xcconfig pattern is documented and
works, but you write the schemes by hand. Android gets this for free from product flavours; iOS
does not.

**A signed force-update policy.** `nativePolicy` travels beside the signed manifest rather than
inside it, so `severity` and `minSupportedNativeVersion` are whatever the update server said. The
destination is already handled — the client uses your `config.storeUrl` and ignores the server's —
but a breached backend can still hold every install behind a blocking gate.

Fixing it means a second signed artifact with its own lifecycle, and that is the hard part rather
than the signature: the policy is operational state that changes far more often than a release, so
requiring the offline signing key for every change trades an availability risk for an operational
one. The likely shape is short-expiry policy documents pre-signed alongside a release, with the
unsigned field kept as a fallback for clients that predate it. Deliberately not bolted on as a
patch.

**A wider React Native version matrix.** Tested against 0.79+ with the New Architecture. Older
versions are not tested and the TurboModule spec assumes the New Architecture.

## Known rough edges

These are shipped and working, with sharp corners worth knowing about:

- **Rollback is one-way.** `dash-ota rollback` sets both `rolledBack` and `paused`, and while
  `pause --resume` clears the pause, nothing clears `rolledBack`. Recovering means publishing a new
  release. There is no unpublish or delete.
- **No `promote` command.** The channel is signed into the manifest, so moving a release from dev
  to prod is a fresh `publish --channel prod`, not a promotion. Blobs that prod already has are
  skipped, so the re-upload is usually small.
- **Download progress is Android-only.** The client subscribes to the native `onDashOtaProgress`
  event and reports 0–1 while downloading, but only Android emits it. On iOS `ui.progress` stays
  `null` (indeterminate) until the download completes, so render a spinner for `null` rather than
  a zero-width bar.
- **The dashboard cannot express every CLI option** — no `--no-encrypt`, no `--allow-insecure`, no
  explicit `--bundle-version`. Its `runtimeVersion` is a static config string with no fingerprint
  integration, so a native change can publish under a stale runtime if you forget to update it.

Have a need that's not here? Open an issue on
[GitHub](https://github.com/Scripting-Bear/dash-ota/issues).
