---
sidebar_position: 2
title: Controls explained
---

# Controls explained

Each control and the precise property it provides.

## Ed25519 manifest signing → integrity
- **Property:** only your CI can produce a manifest the app will accept.
- **Why native:** verification happens before JS runs, against an embedded key → a tampered bundle
  never executes, even over a hostile network.
- **Covers:** the entire manifest — `runtimeVersion`, `bundleVersion`, AES key, and the per-file
  SHA-256 list — so not even one asset can be swapped.

## AES-256-GCM payload encryption → confidentiality + authenticity
- **Property:** the bundle bytes are unreadable to a passive sniffer and at rest; the GCM tag
  detects tampering.
- **Boundary:** the content key rides inside the manifest over TLS, so *active*-MITM confidentiality
  needs the pinning plug-in. Integrity does not.

## Hardware device-key auth → no secret at bootstrap
- **Property:** the device proves itself with a key generated in the Secure Enclave / AndroidKeyStore;
  only the public half is ever transmitted. There's nothing to intercept or replay at enrollment.
- **Signing:** requests carry an ECDSA-P256 signature over a canonical string + nonce + timestamp.

## Anti-replay → request freshness
- **Property:** a reused nonce or stale timestamp is rejected; a `/confirm` must echo the server
  nonce from a real `/check`.

## runtimeVersion + downgrade guards → safe application
- **Property:** an OTA only applies on a matching native generation, and never downgrades — defeating
  "old validly-signed bundle" replay.

## Crash-loop breaker + auto-pause → reliability
- **Property:** a bad bundle can't brick the app (client revert) and can't keep spreading (server
  auto-pause).

## CSPRNG request nonce → unpredictable anti-replay
- **Property:** the request nonce comes from the platform CSPRNG (Android `SecureRandom`, iOS
  `SecRandomCopyBytes`), not `Math.random`, so it can't be predicted or precomputed.

## Signed-size download bound → memory-DoS + swap resistance
- **Property:** the native download is bounded by the manifest's **signed** `ciphertextSize` — a
  server/MITM can't return an oversized body to exhaust memory, and a swapped/truncated body is
  rejected before decryption. At publish, `/admin/publish` also rejects a ciphertext over
  `maxBundleBytes` and cross-checks the signed size.

## Rate limiting → abuse resistance
- **Property:** `/enroll` and `/check` are rate-limited per install (fixed window, `429` +
  `Retry-After`). Backed by the `CacheProvider`, so a shared Redis enforces it across instances.
  Cross-install / IP flood protection is delegated to the reverse proxy.

## Admin auth → fail-closed trust root
- **Property:** the admin token is compared in constant time and has **no default** — unset ⇒
  `/admin/*` is disabled (`503`). The CLI signing key is encrypted at rest and self-verifies each
  release before upload.

## Defense-in-depth (implemented, opt-in)
- **TLS pinning** (native, per-flavour pins) closes active-MITM confidentiality on the bundle download.
- **Attestation** (Play Integrity / App Attest) + **hardware-key provenance** raise the bar against
  cloned/modified apps and software-key downgrades.

Both are off by default and customizable. → [Pinning & attestation](/docs/security/pinning-attestation)
