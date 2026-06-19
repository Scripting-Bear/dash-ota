---
sidebar_position: 4
title: Native vs JS trust split
description: Why the trust-critical work runs in native, before and independent of JavaScript.
---

# Native vs JS trust split

dash-ota draws a hard line between what JS may do and what only native may do.

## JS may: orchestrate
- Resolve the install id, call `/enroll` / `/check` / `/confirm` (small JSON requests).
- Decide *when* to check (launch, foreground, manual button).
- Surface status to your UI via `useOtaUpdate()`.
- Plug in `TransportSecurity` (pinning) later.

JS is treated as **untrusted** for any security decision — because a malicious OTA bundle *is*
JS, and code can't be trusted to police itself.

## Native must: decide trust
All of these happen in Kotlin/Swift, **before** the JS bundle runs and independent of it:

- **Ed25519 signature verification** against the embedded public key.
- **`runtimeVersion` and `bundleVersion`** checks.
- **AES-256-GCM decryption** and **per-file SHA-256** verification.
- **Atomic slot swap** and **crash-loop rollback**.
- **Hardware device-key** generation and request signing.
- The **`getJSBundleFile()` / `bundleURL()`** hook that picks which bundle the app boots from.

## Why this matters

Consider the worst case: an attacker fully controls your backend and the network. They serve a
malicious JS bundle.

- It is **encrypted and signed?** No — they don't have your private key.
- Native verifies the Ed25519 signature against the **embedded** key → **fails** → the bundle is
  deleted and never runs. The app stays on its last-known-good/embedded bundle.

Because the verdict is made in native against a key the attacker can't reach, **a compromised JS
layer cannot escalate** into running unverified code.

## The provider's role

The `<DashOtaProvider>` and `useOtaUpdate()` hook are pure orchestration. They call into the
native `DashOta` TurboModule for every trust-critical operation (`downloadAndStage`,
`applyOnNextLaunch`, `markHealthy`, `rollback`, `getDevicePublicKeyB64`, `signWithDeviceKey`). The
hook never sees a private key or makes a verification decision.

→ [Slot model & atomic apply](/docs/architecture/slot-model) · [Request signing](/docs/architecture/request-signing)
