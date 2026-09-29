---
sidebar_position: 1
title: Manifest schema
---

# Manifest schema

The manifest is the signed source of truth for a release. The Ed25519 signature covers the whole
`manifest` object, so nothing in it can be altered after signing — including every hash and size
the device later uses to check a download.

```jsonc
{
  "manifest": {
    "schema": 2,
    "protocol": 2,
    "bundleId": "bnd_rt1_8_mumg5z84",
    "runtimeVersion": "rt1",          // must match the binary's
    "bundleVersion": 8,               // must exceed the running bundle's; downgrade guard
    "platform": "android",            // ios | android
    "channel": "prod",                // dev | uat | prod
    "appId": "com.example.app",       // package name / bundle id; the device refuses a mismatch
    "createdAt": "2026-09-10T09:12:44.000Z",
    "mandatory": false,
    "releaseNotes": "Fix order confirmation crash",
    "targetAppVersions": ">=1.2.0 <1.3.0",   // optional
    "minNativeBuild": 42,                     // optional; older native builds are not offered it
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
  "signatureB64": "...",              // Ed25519 over canonicalize(manifest)
  "keyId": "key_prod_1"               // envelope copy; the backend uses it to find the registered key
}
```

## How native uses it

1. Verify `signatureB64` over the **canonical bytes** of `manifest` against every public key
   embedded in the binary; any one of them may verify it. `keyId` is not used to pick. Nothing
   below is trusted until this passes.
2. Check `schema` is 2, `appId` matches this app, `runtimeVersion` matches the binary, and, from
   0.5.1, that `channel` and `platform` match the binary and `minNativeBuild` is not above the
   installed native build. Then check `bundleVersion` is higher than the running bundle's and the
   release has not been disabled by the crash-loop breaker.
3. Check `bundleId` and every hash are safe file names (0.5.1 and later), and validate every
   `path` before writing anything. A valid signature over `../../etc/passwd` is still a valid
   signature.
4. For each file: skip it if a file with that `sha256` is already on the device, otherwise fetch
   `blob.sha256`, check the blob hash, decrypt, decompress, and check `sha256` and `size` again.
5. Commit the slot only when every file the manifest lists is present.

## Why per-file hashes

A single payload-wide hash would let an attacker swap one asset inside an otherwise-valid release.
The signed per-file list closes that: the device rejects the release if any file mismatches. The
same list is what makes reuse safe — a file is only reused when its hash matches what this manifest
demands.

## One content key per channel

`encryption.contentKeyB64` is reused by every release, not a fresh key per release. The CLI keeps
one per signing key (`<keyId>.content.key`), so it is one per channel when each channel has its own
key. Combined with a nonce derived from the bytes being sealed, that makes encryption convergent:
an unchanged file produces identical stored bytes every time, which is what lets the blob store
keep one copy of it. See [Honest limitations](/docs/security/limitations) for what that does and
does not cost.

→ [Content-addressed blobs](/docs/architecture/content-addressed-blobs) ·
[Request signing](/docs/architecture/request-signing)
