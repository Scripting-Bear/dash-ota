---
sidebar_position: 8
title: Endpoints & request signing
---

# Endpoints & request signing

All client endpoints (except `/enroll`) are authenticated with the device-key signature.

## Client endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/ota/v2/enroll` | enroll token | register the device's public key |
| POST | `/ota/v2/check` | device-key sig | get an eligible update (signed manifest + download token) |
| GET | `/ota/v2/releases/:bundleId/blobs/:blobSha256` | download token | stream one blob (**no S3 URL**) |
| POST | `/ota/v2/confirm` | device-key sig | report apply result (drives adoption + auto-pause) |

The blob endpoint supports `Range` for resume (`206`, and `416` when unsatisfiable), sends an
`ETag` and `Cache-Control: immutable` because a content-addressed blob can never change, and
returns `410` once a release is paused or rolled back — even to a device holding a live token. A
token is scoped to one release, and the release's signed manifest must actually list the blob.

`/ota/v1/*` still answers, but only with a tombstone telling the client to update from the store.
Those requests are counted per channel and platform so you can see how much of your install base
is still on a pre-v2 binary.

## Admin endpoints

Header `x-ota-admin-token: <adminToken>`. Used by the [CLI](/docs/cli/overview).

| Method | Path | Purpose |
|---|---|---|
| POST | `/admin/keys` | register a trusted Ed25519 public key (`{ keyId, publicKeyRawB64 }`) |
| POST | `/admin/releases` | declare a release (`{ signedManifest, rolloutPercentage? }`); replies with `missing[]` — the blobs the store does not already hold |
| PUT | `/admin/releases/:bundleId/blobs/:blobSha256` | upload one blob, streamed and hash-checked as it arrives |
| POST | `/admin/releases/:bundleId/finalize` | make the release servable; refuses while any blob is missing |
| GET | `/admin/releases/:bundleId` | one release, including its signed manifest |
| GET | `/admin/releases` | list releases + adoption/health |
| POST | `/admin/rollout` | `{ bundleId, rolloutPercentage }` |
| POST | `/admin/pause` | `{ bundleId, paused }` |
| POST | `/admin/rollback` | `{ bundleId }` |
| POST | `/admin/native-policy` | `{ channel, minSupportedNativeVersion, severity, storeUrl? }` |

Plus `GET /health` (liveness) and `GET /ready` (readiness, with a release count).

## Publishing takes three steps

A release is invisible to devices until it is finalized, which is what makes an interrupted publish
safe to re-run: declare it again and upload only what is still missing.

```
POST /admin/releases            → { bundleId, missing: [sha, ...] }
PUT  /admin/releases/:id/blobs/:sha   (once per missing blob)
POST /admin/releases/:id/finalize
```

`missing[]` is usually far shorter than the file list, because blobs are shared across releases —
an unchanged asset is already in the store. Publishing a release that changes one asset typically
uploads two blobs: that asset and the JS bundle.

A finalized release is **immutable**: re-publishing the same `bundleId` returns `409`. Publish a
new `bundleVersion` instead.

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
