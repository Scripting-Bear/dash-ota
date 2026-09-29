---
sidebar_position: 3
title: Controls explained
---

# Controls explained

Each control and the precise property it provides.

## Ed25519 manifest signing → integrity
- **Property:** only whoever holds your signing key can produce a manifest the app will accept.
- **Why native:** verification runs in native code against keys compiled into the binary, before
  anything is written to disk → JS cannot skip it, and a tampered bundle never executes, even over a
  hostile network.
- **Covers:** the entire manifest — `runtimeVersion`, `bundleVersion`, AES key, and the per-file
  SHA-256 list — so not even one asset can be swapped.

## AES-256-GCM blob encryption → blob-store confidentiality + authenticity
- **Property:** blob bytes are unreadable to someone who can read the blob store or a cache in
  front of it but not the manifests; the GCM tag detects tampering.
- **Boundary:** the content key is in the manifest, which `/check` returns to any enrolled install
  for the channel it asks about. It does not hide bundles from the server operator, from an enrolled
  install, from an active MITM on `/check` (JavaScript requests are not pinned unless you pin them),
  or from anyone who can read the device's storage, where files are kept decrypted. Integrity does
  not depend on it.

## Device-key auth → no shared secret at bootstrap
- **Property:** the device proves itself with an EC P-256 key generated in the AndroidKeyStore or
  the iOS Secure Enclave; only the public half is transmitted, so enrollment issues no secret to
  intercept. iOS falls back to a software Keychain key when the Secure Enclave is unavailable, unless
  you set `OTA_REQUIRE_HARDWARE_KEY`.
- **Signing:** requests carry an ECDSA-P256 signature over the method, path, install id, nonce,
  timestamp and body hash.

## Anti-replay → request freshness
- **Property:** a reused nonce or stale timestamp is rejected; a `/confirm` must echo the server
  nonce from a real `/check`. Keep `nonceTtlMs` at least twice `timestampSkewMs` (the defaults are
  10 and 5 minutes), or a request replayed after its nonce expires is accepted.

## runtimeVersion + downgrade guard → safe application
- **Property:** an OTA only applies on a binary with the same `runtimeVersion`, and only if its
  `bundleVersion` is higher than the running bundle's.
- **Boundary:** the guard compares against the running bundle only; nothing is persisted. After a
  store update, a `rollback()` or a crash-loop revert, an older signed release above the new
  current version installs again. See [If your server is breached](/docs/security/breach).

## Crash-loop breaker + auto-pause → reliability
- **Property:** a bundle that crashes on two charged cold starts is disabled on that device, which
  reverts to last-known-good or the embedded bundle (client), and a release whose failure rate reaches 20% over at least
  5 reports stops being offered (server auto-pause). A bundle that runs but misbehaves is not caught
  by either.

## CSPRNG request nonce → unpredictable anti-replay
- **Property:** the request nonce comes from the platform CSPRNG (Android `SecureRandom`, iOS
  `SecRandomCopyBytes`), not `Math.random`, so it can't be predicted or precomputed.

## Signed-size download check → swap resistance and a memory bound on Android
- **Property:** every blob download must match the **signed** `blob.size`, so a swapped or
  truncated body is rejected before anything is decrypted. On Android the download streams to disk
  and stops as soon as it passes that size. On iOS the whole body is read into memory first and then
  compared, so an oversized response costs memory before it is refused. At publish, an uploaded blob
  is streamed against `maxBlobBytes` and rejected as it arrives rather than after.

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
  `Retry-After`); failed enrollments count per client address instead, so they cannot lock a real
  device out. Backed by the `CacheProvider`, so a shared Redis enforces it across instances.
  Cross-install / IP flood protection is delegated to the reverse proxy.

## Admin auth → fail-closed trust root
- **Property:** the admin token is compared in constant time and has **no default** — unset ⇒
  `/admin/*` is disabled (`503`). `keygen` encrypts the signing key with a passphrase unless you
  opt out, and `publish` checks each signature before upload.

## Defense-in-depth (implemented, opt-in)
- **TLS pinning** (native, per-flavour pins) covers blob downloads only. The content key and the
  download token arrive on `/check`, a JavaScript request, which is pinned only if you pass your own
  pinned `fetch` as `transport`.
- **Attestation** (Play Integrity / App Attest) gives your `verifyEnrollToken` a token to check.
  The token is not bound to a server challenge, so a captured one can be replayed.
- **`keyHardwareBacked`** is reported by the device itself. The backend cannot prove it, so treat it
  as a hint, not a gate.

Pinning and attestation are off by default. → [Pinning & attestation](/docs/security/pinning-attestation)
