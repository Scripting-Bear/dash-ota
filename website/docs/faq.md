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
No. dash-ota is a TurboModule that uses codegen and synchronous methods, so it needs React Native
0.79 or later with the New Architecture. It has been tested with Hermes, the default engine. The
native module doesn't depend on the engine, but a Hermes bytecode bundle only runs on Hermes: if
your app uses JSC, publish the plain JavaScript bundle (leave out `--hermes`).

### Can a hacked server push malicious code?
No. Manifests are **signed in your CLI** and verified in native against an **embedded** public key,
so a breached server cannot forge or modify a release. It can still withhold updates, re-serve a
release you rolled back or an older signed one in some cases (for example after a store update),
send a `hard` force-update policy that locks users out if your app blocks on it, and read your
bundles. → [If your server is breached](/docs/security/breach)

### Is the bundle encrypted end-to-end?
No. Blobs are **AES-256-GCM** encrypted in the blob store and on the wire, but the content key is in
the manifest, which `/check` returns to any enrolled install. Devices store the decrypted files, the
server operator can decrypt everything, and so can an active MITM who can read `/check` (JavaScript
requests are not pinned unless you pin them). The encryption protects the blob store; integrity
comes from the signature. → [Security model](/docs/concepts/security-model)

### Do I have to run a backend?
Yes — that's the point (ownership). It's small: one [Express middleware](/docs/backend/express) or a
standalone server. For scale, swap the store for Postgres/Redis/object storage.

### How is this different from Stallion / hot-updater / CodePush?
All three, and Expo, offer bundle signing as an option. In dash-ota signing is mandatory: there is
no unsigned mode, every release is signed in your CI and verified in native, and the server never
holds the key. It is also self-hosted only. Where they are ahead: Stallion and hot-updater (and
Expo) generate binary patches, Stallion has a hosted free tier, and all of them are far more widely
used. → [Comparison](/docs/introduction/comparison)

### What's `runtimeVersion`?
The native-compatibility key. An OTA only applies on a binary with the **exact** same
`runtimeVersion`, so a JS update for a new native build can't land on an old one. → [Versioning](/docs/concepts/versioning-targeting)

### Why didn't my update apply?
Most often: a debug build (uses Metro), a `runtimeVersion` mismatch, an app that embeds a
different public key from the one you signed with, or an HBC/Hermes mismatch.
→ [Troubleshooting](/docs/react-native/troubleshooting)

### Can I roll back?
Yes — `dash-ota rollback` stops the server offering a release, the client crash-loop breaker
reverts a bundle that keeps crashing, and server auto-pause stops a release with a high failure
rate. Devices that already applied a rolled-back release keep running it until they get a newer
release, a crash-loop revert, or your app calls `rollback()`. → [Rollback](/docs/guides/rollback)

### How big are OTA bundles / can I gate on wifi?
Bundles are typically a few MB up to ~tens of MB. Set `autoStage: false` and stage on wifi/consent.
→ [Recipes](/docs/react-native/recipes)

### Is it free / open source?
Yes — MIT, all four packages on npm, source on
[GitHub](https://github.com/Scripting-Bear/dash-ota).
