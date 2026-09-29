---
sidebar_position: 3
title: '@dash-ota/shared'
---

# API — `@dash-ota/shared`

The internal crypto/protocol core shared by the CLI and backend. You rarely import it directly —
app developers use `react-native-dash-ota` and `@dash-ota/backend`.

## Crypto
- `generateSigningKeyPair()` → Ed25519 keypair (`privateKeyPem`, `publicKeyPem`, `publicKeyRawB64`).
- `signManifest(manifest, privateKeyPem)` / `verifyManifest(signed, publicKey)` — Ed25519.
- `publicKeyFromRawB64(b64)` — load an embedded public key.
- `ecdsaP256VerifyB64(...)` / `verifyRequestEcdsa(...)` — device-key request verification (ECDSA P-256).
- `sha256Hex(data)`, `randomNonceB64()`, `randomSecretB64(n)`.

## Release
- `buildReleaseV2({...})` — compress, seal and hash every distinct file, then assemble the
  manifest. Async. Requires a `contentKey` when encrypting: one key per channel, reused for every
  release, because that is what lets the blob store deduplicate. Returns the unsigned manifest and
  a `Map` of blob bytes to upload.
- `verifyReleaseV2(signedManifest, fetchBlob, publicKey)` — verify the signature, then fetch,
  authenticate, decompress and hash every file. This is the reference the native clients mirror.
- `compressForBlob(data, path, level)` / `decompressBlob(data, compression, expectedSize)` — the
  compression policy, including the "skip formats that are already compressed" rule.
- `blobAad(fileSha256)`, `collectBlobShas(manifest)`, `findBlobEntry(manifest, sha)`,
  `totalBlobBytes(manifest)`, `validateManifestShape(manifest)`.
- `validatePath(path)` — the path rules every client enforces before writing.
  → [Content-addressed blobs](/docs/architecture/content-addressed-blobs)

## Protocol & targeting
- `requestSigningString({ method, path, installId, nonce, timestamp, bodySha256 })` — the canonical
  string. → [Request signing](/docs/architecture/request-signing)
- `OTA_HEADERS` — the request header names.
- `isEligible(manifest, device)`, `rolloutBucket(installId, bundleId)` — targeting/rollout matching.
- Protocol types: `EnrollRequest`, `CheckRequestV2`, `CheckResponse`, `ConfirmRequest`,
  `SignedManifest`, `ManifestV2`, `FileEntryV2`, `BlobEntry`, `DeviceContext`,
  `NativeVersionPolicy`, `ConfirmStatus`.

## Fingerprint
- `fingerprintProject(dir)` → the native-compatibility `runtimeVersion` + its inputs.

:::note
Crypto is pure Node `crypto`. The one runtime dependency is `@mongodb-js/zstd`, used for
compression, and it declares `node >= 20.19.0` — that dependency is what sets the Node floor for
the CLI and the backend.
:::
