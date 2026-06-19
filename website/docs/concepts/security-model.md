---
sidebar_position: 2
title: Security model
description: What each control buys, and the precise boundary between integrity and confidentiality.
---

# Security model

dash-ota's security model is deliberately conservative and **honest about its boundaries**. This
page explains what each control actually guarantees.

## The controls

### 1. Ed25519 code signing (integrity)

Every manifest is **signed in the CLI** with an Ed25519 private key that lives only in your CI.
The app embeds the **public** key in its binary and **verifies the signature in native** before a
bundle ever runs.

- The signature covers the *whole* manifest: `runtimeVersion`, `bundleVersion`, the AES content
  key, and the **per-file SHA-256 list** — so an attacker can't swap even a single asset.
- Verification is native and happens *before* JS executes → a tampered bundle never runs, **even
  if TLS is completely broken**.
- The backend never has the private key → **a breached backend cannot forge an update**.

### 2. AES-256-GCM payload encryption (confidentiality + authenticity)

The bundle bytes are AES-256-GCM ciphertext; the content key travels *inside* the signed manifest.
GCM is **authenticated** — the tag detects any tampering of the bytes. This protects against
**passive** sniffing and at-rest exposure.

### 3. Hardware device-key request auth (no secret to intercept)

Each install generates a non-exportable EC P-256 key in the **AndroidKeyStore / Secure Enclave**.
At enroll it registers only the **public** half (gated by your app session token). Requests are
signed with **ECDSA-P256** over a canonical string, plus a nonce and timestamp. There is **no
symmetric secret** transmitted at bootstrap — nothing to sniff or replay.

### 4. Anti-replay

`/check` and `/confirm` carry a per-request **nonce + timestamp** (rejected if stale/reused), and
`/check` issues a **server nonce** that `/confirm` must echo — binding a confirm to a real check.

### 5. Targeting guards

- **runtimeVersion gate** — native refuses any bundle whose `runtimeVersion` ≠ the binary's.
- **Downgrade guard** — native rejects a `bundleVersion` lower than current (defeats replay of a
  validly-signed *old* bundle).

## The integrity vs confidentiality boundary

This is the most important nuance, stated plainly:

> **Integrity is guaranteed in v1, even against an active MITM. Confidentiality against an
> *active* MITM is not — it waits for the (modular) pinning plug-in.**

Why: Ed25519 verification uses a key **embedded in the binary**, so integrity holds regardless of
the network. But the AES **content key** rides inside the manifest over the same TLS channel — an
attacker who can forge a CA and read `/check` could read the key. So AES-GCM gives you
**defense-in-depth confidentiality** (passive sniffing, at-rest), and **active-MITM
confidentiality** is closed only by [TLS pinning](/docs/security/pinning-attestation).

Don't oversell encryption as MITM-proof; do rely on signing for integrity.

## What's deliberately deferred (and modular)

- **TLS certificate/public-key pinning** — closes active-MITM confidentiality.
- **Device attestation** (Play Integrity / App Attest) — proves a genuine, unmodified app.

Both are **modular plug-ins** the core never depends on, so they drop in later without changes.
→ [Pinning & attestation](/docs/security/pinning-attestation)

## See also

- [Threat model table](/docs/security/threat-model)
- [Key management & rotation](/docs/security/key-management)
- [Honest limitations](/docs/security/limitations)
