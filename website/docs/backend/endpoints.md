---
sidebar_position: 8
title: Endpoints & request signing
---

# Endpoints & request signing

All client endpoints (except `/enroll`) are authenticated with the device-key signature.

## Client endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/ota/v1/enroll` | enroll token | register the device's public key |
| POST | `/ota/v1/check` | device-key sig | get an eligible update (manifest + 1-time download token) |
| GET | `/ota/v1/download` | one-time token | stream the AES-GCM ciphertext (**no S3 URL**) |
| POST | `/ota/v1/confirm` | device-key sig | report apply result (drives adoption + auto-pause) |

## Admin endpoints

Header `x-ota-admin-token: <adminToken>`. Used by the [CLI](/docs/cli/overview).

| Method | Path | Purpose |
|---|---|---|
| POST | `/admin/keys` | register a trusted Ed25519 public key (`{ keyId, publicKeyRawB64 }`) |
| POST | `/admin/publish` | store a pre-signed release (`{ signedManifest, ciphertextB64, rolloutPercentage? }`) |
| GET | `/admin/releases` | list releases + adoption/health |
| POST | `/admin/rollout` | `{ bundleId, rolloutPercentage }` |
| POST | `/admin/pause` | `{ bundleId, paused }` |
| POST | `/admin/rollback` | `{ bundleId }` |
| POST | `/admin/native-policy` | `{ channel, minSupportedNativeVersion, severity, storeUrl? }` |

Plus `GET /health`.

## Request signing (client → backend)

Headers on signed requests:

```
x-ota-install:   <installId>
x-ota-nonce:     <random nonce>
x-ota-timestamp: <ms since epoch>
x-ota-signature: <base64 ECDSA-P256 signature>
```

The signature is **ECDSA-P256** over the canonical string:

```
METHOD \n path \n installId \n nonce \n timestamp \n sha256Hex(body)
```

…made with the device's hardware private key. The backend verifies it against the public key
registered at `/enroll`, checks the timestamp window, and rejects a reused nonce. This is all
handled for you by [`react-native-dash-ota`](/docs/react-native/use-ota-update) on the client.

→ [Request-signing internals](/docs/architecture/request-signing)
