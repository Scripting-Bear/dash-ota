---
sidebar_position: 4
title: Concepts & glossary
description: The words the rest of the docs use — runtime version, bundle version, channel, manifest, device key and more.
---

# Concepts & glossary

The words the rest of the docs use, in the order you meet them.

### release

One published update: a JavaScript bundle and its assets, with a signed manifest. It's identified
by its `bundleId`, which looks like `bnd_rt1_2_mumketyh`.

### runtimeVersion

A string that names a native build. The app embeds it, every release carries one, and a device only
installs a release with exactly the same value. Change it whenever native code, a native dependency
or the React Native version changes, so a JavaScript update written for a new store build can't
reach an old one. A fixed string like `rt1` works; `--runtime-version auto` computes one from your
project instead, and it changes with any dependency change, JavaScript-only ones included.
→ [Versioning & targeting](/docs/concepts/versioning-targeting)

### bundleVersion

A whole number that goes up with every release. A device only installs a release with a higher
`bundleVersion` than the bundle it runs now; the bundle shipped inside the app counts as 0.
→ [Versioning & targeting](/docs/concepts/versioning-targeting)

### channel

The lane a build belongs to: `dev`, `uat` or `prod`. It's compiled into each build flavour, and a
device only takes releases published to its channel. Give each channel its own signing key.
→ [Environments](/docs/react-native/environments)

### manifest

The signed description of a release: `bundleId`, runtime version, bundle version, platform,
channel, app id, the mandatory flag, release notes, the content key, and the path, size and
SHA-256 of every file. The Ed25519 signature covers all of it.
→ [Manifest schema](/docs/architecture/manifest-schema)

### signing key

The Ed25519 key pair `keygen` makes. The private half signs releases and stays with you or your
CI. The public half is compiled into the app, which uses it to check every release.
→ [Keys, custody & rotation](/docs/security/key-management)

### device key

A P-256 key pair each install creates on first launch, in the Android Keystore or, on iOS, the
Secure Enclave where available (it falls back to a software key unless you require hardware). The
device signs its requests with it; the server only ever sees the public half.
→ [Security model](/docs/concepts/security-model)

### slot

A place on the device where a bundle lives. dash-ota tracks `current`, `lastKnownGood`, `staged`
(downloaded and verified) and `pending` (applies on the next cold start).
→ [Slot model](/docs/architecture/slot-model)

### markHealthy

The call your app makes once its first real screen works. It ends the new bundle's trial and makes
it the last known good one. → [markHealthy](/docs/react-native/mark-healthy)

### crash-loop breaker

A new bundle runs on trial. If it crashes on two cold starts before `markHealthy()`, the device
switches it off and goes back to the last bundle that worked. A launch where the app starts and the
user simply leaves doesn't count. → [Crash-loop breaker](/docs/concepts/crash-loop)

### rollout percentage

The share of devices a release is offered to. Each device gets a fixed bucket per release, so it
doesn't flip in and out between checks. → [Staged rollouts](/docs/guides/staged-rollout)

### targetAppVersions

An optional semver range over your app's version (for example `>=1.2.0 <1.3.0`) that limits a
release to certain app versions. The server checks it.
→ [Versioning & targeting](/docs/concepts/versioning-targeting)

### force-update gate

A per-channel policy, set with `native-policy`, that tells binaries below a minimum native build
number to update from the store. The app decides what to show.
→ [Force update](/docs/concepts/force-update)
