---
sidebar_position: 1
title: Manifest schema
---

# Manifest schema

The manifest is the signed source of truth for a release. The Ed25519 signature covers the whole
`manifest` object, so nothing in it can be altered after signing.

```jsonc
{
  "manifest": {
    "bundleId": "bnd_rt1_8_abc",
    "runtimeVersion": "rt1",          // must match the binary's
    "bundleVersion": 8,               // monotonic; downgrade guard
    "platform": "android",            // ios | android
    "channel": "prod",                // dev | uat | prod
    "mandatory": false,
    "releaseNotes": "Fix order confirmation crash",
    "targetAppVersions": ">=1.2.0 <1.3.0", // optional
    "encryption": {
      "contentKeyB64": "...",         // AES-256-GCM key (verified, so native can trust it)
      "ivB64": "...",
      "tagB64": "...",
      "ciphertextSha256": "..."       // hash of the encrypted payload
    },
    "files": [
      { "path": "index.android.bundle", "size": 884032, "sha256": "..." },
      { "path": "assets/logo.png",      "size": 2048,   "sha256": "..." }
    ]
  },
  "signatureB64": "...",              // Ed25519 over canonicalize(manifest)
  "keyId": "key_prod_1"               // which trusted key signed it
}
```

## How native uses it

1. Recompute the **canonical bytes** of `manifest` and verify `signatureB64` against the embedded
   public key for `keyId`.
2. Check `runtimeVersion` == binary's and `bundleVersion` > current.
3. Hash the downloaded ciphertext and compare to `encryption.ciphertextSha256`.
4. AES-256-GCM decrypt with `contentKeyB64` / `ivB64` / `tagB64` (the tag authenticates the bytes).
5. Unpack and verify **every** entry in `files` (size + sha256).

## Why per-file hashes

A single-blob hash would let an attacker swap one asset within an otherwise-valid payload. The
signed per-file list closes that — native rejects the whole release if any file mismatches.

→ [SOA1 archive format](/docs/architecture/soa1-archive) · [Request signing](/docs/architecture/request-signing)
