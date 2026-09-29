---
sidebar_position: 3
title: '@dash-ota/shared'
---

# `@dash-ota/shared`

The signing, protocol and release code the CLI and backend share. You rarely import it yourself;
apps use `react-native-dash-ota` and servers use `@dash-ota/backend`.

## Crypto
- `generateSigningKeyPair()` → Ed25519 keypair (`privateKeyPem`, `publicKeyPem`, `publicKeyRawB64`).
- `signManifest(manifest, privateKeyPem)` / `verifyManifest(signed, publicKey)`: Ed25519.
- `publicKeyFromRawB64(b64)`: load a public key in the form apps embed.
- `ecdsaP256VerifyB64(...)` / `verifyRequestEcdsa(...)`: check a device's request signature (ECDSA P-256).
- `sha256Hex(data)`, `randomNonceB64()`, `randomSecretB64(n)`.

## Release
- `buildReleaseV2({...})`: compress, encrypt and hash every distinct file, then assemble the
  manifest. Async. Requires a `contentKey` when encrypting: one key per channel, reused for every
  release, because that is what lets the blob store deduplicate. Returns the unsigned manifest and
  a `Map` of blob bytes to upload.
- `verifyReleaseV2(signedManifest, fetchBlob, publicKey)`: verify the signature, then fetch,
  authenticate, decompress and hash every file. This is the reference the native clients mirror.
- `compressForBlob(data, path, level)` / `decompressBlob(data, compression, expectedSize)`: the
  compression policy, including the "skip formats that are already compressed" rule.
- `blobAad(fileSha256)`, `collectBlobShas(manifest)`, `findBlobEntry(manifest, sha)`,
  `totalBlobBytes(manifest)`, `validateManifestShape(manifest)`.
- `validatePath(path)`: the path rules every client enforces before writing. See
  [Content-addressed blobs](/docs/architecture/content-addressed-blobs).

## Protocol & targeting
- `requestSigningString({ method, path, installId, nonce, timestamp, bodySha256 })`: the string a
  device signs. See [Request signing](/docs/architecture/request-signing).
- `OTA_HEADERS`: the request header names.
- `isEligible(manifest, device)`, `rolloutBucket(installId, bundleId)`: which devices get a release.
- Protocol types: `EnrollRequest`, `CheckRequestV2`, `CheckResponse`, `ConfirmRequest`,
  `SignedManifest`, `ManifestV2`, `FileEntryV2`, `BlobEntry`, `DeviceContext`,
  `NativeVersionPolicy`, `ConfirmStatus`.

## Fingerprint
- `computeRuntimeVersion(inputs)`: hashes `{ nativeDependencies, nativeDirHashes, hermesVersion,
  reactNativeVersion, salt? }` into a runtime version. It doesn't read files; the CLI collects the
  inputs (every dependency in `package.json`, and the git-tracked files under `android/` and `ios/`).

:::note
Crypto is pure Node `crypto`. The one runtime dependency is `@mongodb-js/zstd`, used for
compression. It needs Node 20.19 or later, which is why the CLI and backend do.
:::
