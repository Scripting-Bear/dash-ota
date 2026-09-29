---
sidebar_position: 4
title: Native vs JS trust split
description: Why every trust decision is made in native code, never in JavaScript.
---

# Native vs JS trust split

dash-ota draws a line between what JavaScript does and what only native code decides.

## JavaScript orchestrates

- Keeps the install id and calls `/enroll`, `/check` and `/confirm` (small JSON requests).
- Decides when to check: at launch, when the app comes to the foreground, or when you ask.
- Reports status to your UI through `useOtaUpdate()`.
- Accepts optional plug-ins: `transport` (for example a pinned `fetch`) and `attestor`.

JavaScript is never trusted to make a security decision, because a malicious update would itself be
JavaScript.

## Native code decides

These run in Kotlin and Swift. The checks on a new release all happen before any of its files are
written, and long before its JavaScript can run:

- the Ed25519 signature, against the public keys compiled into the binary;
- the app id, runtime version, channel, platform and minimum native build (the last three from
  0.5.1), and that the bundle version is newer than the one running;
- each file's hash, AES-256-GCM authentication and decompression limits;
- the slot swap on a cold start, and the crash-loop breaker;
- the device key (in the Android Keystore, or the iOS Secure Enclave where available) and the
  request signatures made with it;
- the `getJSBundleFile()` / `bundleURL()` hook that picks which bundle the app starts from.

## Why it matters

Take the worst case: an attacker controls your backend and the network, and serves their own
JavaScript bundle.

- They can't sign it, because the private key never left your machine or CI.
- Native code checks the signature against the key compiled into the app, the check fails, nothing
  is written, and the app keeps running the bundle it had.

Because the decision is made in native code against a key the attacker can't reach, controlling the
server or the network doesn't let them run their code. What they can still do is covered in
[If your update server is breached](/docs/security/breach).

## The provider's role

`<DashOtaProvider>` and `useOtaUpdate()` only orchestrate. Every step that matters for trust goes
through the native `DashOta` module: `downloadAndStage`, `applyOnNextLaunch`, `markHealthy`,
`rollback`, `getDevicePublicKeyB64`, `signWithDeviceKey`. The JavaScript side never holds a private
key and never decides whether a release is genuine.

→ [Slot model](/docs/architecture/slot-model) · [Request signing](/docs/architecture/request-signing)
