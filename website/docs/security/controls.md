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
- **Property:** every blob download is bounded by the **signed** `blob.size` for that blob — a
  server or MITM cannot return an oversized body to exhaust memory, and a swapped or truncated body
  is rejected before anything is decrypted. At publish, an uploaded blob is streamed against
  `maxBlobBytes` and rejected as it arrives rather than after.

## Bounded decompression → decompression-bomb resistance
- **Property:** a zstd frame declares its own decompressed size in its header, which is compared
  against the size the signed manifest promises **before** any output is produced — so a bomb is
  refused after a few bytes rather than after it has exhausted memory. Output is also counted as it
  is written, so a frame that lies about its own size cannot overrun the limit either. Measured: a
  12.5 KB frame claiming 400 MB is refused immediately.

## Per-blob AEAD binding → no substitution within a release
- **Property:** each blob is sealed with its plaintext hash as additional authenticated data, so a
  blob cannot be swapped for a different file even by someone who can write to the blob store. It
  is deliberately *not* bound to the release, because one blob is shared by every release that
  contains that file. Which blob belongs to which file is asserted by the signed manifest, and the
  device re-hashes the plaintext after decrypting regardless.

## Convergent nonces → dedup without nonce reuse
- **Property:** the nonce for a blob is derived from the hash of the exact bytes being sealed, not
  from the plaintext hash and not at random. Equal nonce therefore implies equal message, which is
  what AES-GCM requires: the same file seals identically every time (so the store keeps one copy),
  while two different messages can never share a nonce. Deriving from the plaintext hash instead
  would hand the same nonce to two different messages whenever one file is compressed at two
  different levels.

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
