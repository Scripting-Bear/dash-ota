---
sidebar_position: 1
title: Manifest schema
---

# Manifest schema

The manifest is the signed source of truth for a release. The Ed25519 signature covers the whole
`manifest` object, so nothing in it can be altered after signing — including every hash and size
the device later uses to bound a download.

```jsonc
{
  "manifest": {
    "schema": 2,
    "protocol": 2,
    "bundleId": "bnd_rt1_8_abc",
    "runtimeVersion": "rt1",          // must match the binary's
    "bundleVersion": 8,               // monotonic; downgrade guard
    "platform": "android",            // ios | android
    "channel": "prod",                // dev | uat | prod
    "appId": "com.example.app",       // package name / bundle id; the device refuses a mismatch
    "createdAt": "2026-09-10T09:12:44.000Z",
    "mandatory": false,
    "releaseNotes": "Fix order confirmation crash",
    "targetAppVersions": ">=1.2.0 <1.3.0",   // optional
    "minNativeBuild": 42,                     // optional force-update hint
    "encryption": {
      "mode": "aes-256-gcm",          // or { "mode": "none" }
      "contentKeyB64": "..."          // per channel, not per release — see below
    },
    "files": [
      {
        "path": "index.android.bundle",
        "role": "bundle",             // present on the JS bundle only
        "sha256": "...",              // the file's real bytes
        "size": 25760000,
        "blob": {
          "sha256": "...",            // the stored bytes: compressed, then sealed
          "size": 7280000,
          "compression": "zstd",      // or "none"
          "ivB64": "...",
          "tagB64": "..."
        }
      }
    ],
    "patches": [],                    // reserved for bytecode deltas
    "keyId": "key_prod_1"
  },
  "signatureB64": "..."               // Ed25519 over canonicalize(manifest)
}
```

## How native uses it

1. Recompute the **canonical bytes** of `manifest` and verify `signatureB64` against the embedded
   public key for `keyId`. Nothing below is trusted until this passes.
2. Check `schema` is 2, `appId` matches this app, `runtimeVersion` matches the binary,
   `bundleVersion` is newer, and the release is not disabled.
3. Validate every `path` before writing anything. A valid signature over `../../etc/passwd` is
   still a valid signature.
4. For each file: skip it if a file with that `sha256` is already on the device, otherwise fetch
   `blob.sha256`, check the blob hash, decrypt, decompress, and check `sha256` and `size` again.
5. Commit the slot only when every file the manifest lists is present.

## Why per-file hashes

A single payload-wide hash would let an attacker swap one asset inside an otherwise-valid release.
The signed per-file list closes that: the device rejects the release if any file mismatches. The
same list is what makes reuse safe — a file is only reused when its hash matches what this manifest
demands.

## One content key per channel

`encryption.contentKeyB64` is a **channel** key, reused by every release, not a fresh key per
release. Combined with a nonce derived from the bytes being sealed, that makes encryption
convergent: an unchanged file produces identical stored bytes every time, which is what lets the
blob store keep one copy of it. See [the security model](/docs/concepts/security-model) for what
that does and does not cost.

→ [Content-addressed blobs](/docs/architecture/content-addressed-blobs) ·
[Request signing](/docs/architecture/request-signing)
