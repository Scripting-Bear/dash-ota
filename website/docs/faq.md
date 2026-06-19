---
sidebar_position: 11
title: FAQ
---

# FAQ

### Is dash-ota allowed by the App Store / Play Store?
OTA of **JavaScript** is generally acceptable (it doesn't change native binary behaviour). Don't use
it to ship features that circumvent review. Native changes still require a store release — that's
what the [force-update gate](/docs/concepts/force-update) is for.

### Does it work without the New Architecture?
No. dash-ota is a TurboModule using codegen + sync methods; it requires **RN 0.79+ with the New
Architecture** and Hermes.

### Can a hacked server push malicious code?
No. Manifests are **signed in your CLI** and verified in native against an **embedded** public key.
A breached server can at worst serve a validly-signed *older* bundle, which the downgrade guard
rejects. → [Security model](/docs/concepts/security-model)

### Is the bundle encrypted end-to-end?
It's **AES-256-GCM** encrypted (authenticated). That protects passive sniffing + at-rest exposure.
*Active*-MITM confidentiality needs the [TLS pinning](/docs/security/pinning-attestation) plug-in;
integrity is guaranteed regardless.

### Do I have to run a backend?
Yes — that's the point (ownership). It's small: one [Express middleware](/docs/backend/express) or a
standalone server. For scale, swap the store for Postgres/Redis/object storage.

### How is this different from Stallion / hot-updater / CodePush?
The security model: native-verified signing, payload encryption, hardware device-key auth, and a
backend that can't forge updates. → [Comparison](/docs/introduction/comparison)

### What's `runtimeVersion`?
The native-compatibility key. An OTA only applies on a binary with the **exact** same
`runtimeVersion`, so a JS update for a new native build can't land on an old one. → [Versioning](/docs/concepts/versioning-targeting)

### Why didn't my update apply?
Most often: a debug build (uses Metro), a `runtimeVersion` mismatch, `markHealthy()` never called, or
an HBC/Hermes mismatch. → [Troubleshooting](/docs/react-native/troubleshooting)

### Can I roll back?
Yes — `dash-ota rollback`, plus the automatic client crash-loop breaker and server auto-pause.
→ [Rollback](/docs/guides/rollback)

### How big are OTA bundles / can I gate on wifi?
Bundles are typically a few MB up to ~tens of MB. Set `autoStage: false` and stage on wifi/consent.
→ [Recipes](/docs/react-native/recipes)

### Is it free / open source?
Yes — MIT, all four packages on npm, source on
[GitHub](https://github.com/Scripting-Bear/dash-ota).
