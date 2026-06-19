---
sidebar_position: 3
title: Concepts & glossary
description: The vocabulary you need — runtimeVersion, bundleVersion, channel, manifest, device key, and more.
---

# Concepts & glossary

A quick glossary. Each links to a deeper page.

### runtimeVersion
The **native-compatibility key**. It changes only when the *native* layer changes (native deps,
TurboModules, Hermes, native code). It's baked into the binary at build time and stamped onto
every OTA. **An OTA is only applied if its `runtimeVersion` exactly matches the binary's** — this
is what stops a JS update built for a new store build from landing on an old one.
→ [Versioning & targeting](/docs/concepts/versioning-targeting)

### bundleVersion
A **monotonic counter** for the OTA lineage *within* a runtimeVersion. Native rejects anything
`< current` (the downgrade guard), except an explicit server-signed rollback.

### channel
A build flavour's lane — typically `dev` / `uat` / `prod`. Each flavour embeds its own channel +
signing key, so an OTA can only reach the matching flavour. → [Environments & flavours](/docs/react-native/environments)

### manifest
The signed JSON describing a release: bundle id, runtimeVersion, bundleVersion, platform, channel,
mandatory flag, release notes, the AES content key, and a **per-file SHA-256 list**. The Ed25519
signature covers the whole thing. → [Manifest schema](/docs/architecture/manifest-schema)

### device key
A non-exportable EC P-256 key generated on first launch in the **AndroidKeyStore / iOS Secure
Enclave**. The device signs its requests with it; only the public half is registered at enroll.
→ [Security model](/docs/concepts/security-model)

### slot
An on-disk bundle location. dash-ota keeps `current`, `lastKnownGood`, and a `pending`/`staged`
slot, plus boot counters. Applies are atomic (write-temp → fsync → rename).
→ [Slot model](/docs/architecture/slot-model)

### markHealthy
The signal — sent by your app **after the first real screen is usable** — that the running bundle
works. If it isn't sent within N launches, the **crash-loop breaker** reverts.
→ [markHealthy & crash-loop](/docs/react-native/mark-healthy)

### rollout %
A deterministic percentage of installs that are eligible for a release (bucketed by a hash of the
install id, so a device doesn't flip in and out between checks). → [Staged rollout](/docs/guides/staged-rollout)

### targetAppVersions
An optional semver range over your marketing/app version, so a release can be limited to specific
app builds (CodePush-style).

### force-update gate
A per-channel policy (`minSupportedNativeVersion` + `severity`) that tells too-old binaries to
**update from the store** instead of receiving an OTA. → [Force-update](/docs/concepts/force-update)
