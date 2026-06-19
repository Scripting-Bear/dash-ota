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

## Release & archive
- `buildRelease({...})` — AES-256-GCM encrypt + build the manifest + per-file hashes.
- `openRelease(signedManifest, ciphertext, publicKey)` — verify + decrypt + unpack (the reference
  the native side mirrors).
- SOA1 archive helpers. → [SOA1 archive](/docs/architecture/soa1-archive)

## Protocol & targeting
- `requestSigningString({ method, path, installId, nonce, timestamp, bodySha256 })` — the canonical
  string. → [Request signing](/docs/architecture/request-signing)
- `OTA_HEADERS` — the request header names.
- `isEligible(manifest, device)`, `rolloutBucket(installId, bundleId)` — targeting/rollout matching.
- Protocol types: `EnrollRequest`, `CheckRequest`, `CheckResponse`, `ConfirmRequest`, `SignedManifest`,
  `DeviceContext`, `NativeVersionPolicy`, `ConfirmStatus`.

## Fingerprint
- `fingerprintProject(dir)` → the native-compatibility `runtimeVersion` + its inputs.

:::note
Pure Node `crypto` — no external crypto dependencies. The full auto-generated reference is built from
the source TSDoc.
:::
