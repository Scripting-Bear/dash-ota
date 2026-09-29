---
sidebar_position: 8
title: Endpoints & request signing
---

# Endpoints & request signing

Device endpoints other than `/enroll` require the device-key signature. Admin endpoints require the
admin token.

## Client endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/ota/v2/enroll` | enroll token | register the device's public key |
| POST | `/ota/v2/check` | device-key sig | get an eligible update (signed manifest + download token) |
| GET | `/ota/v2/releases/:bundleId/blobs/:blobSha256` | download token (`x-ota-download-token` header) | stream one file |
| POST | `/ota/v2/confirm` | device-key sig | report apply result (drives adoption + auto-pause) |

The blob endpoint supports `Range` for resume (`206`, and `416` when unsatisfiable), sends an
`ETag` and `Cache-Control: immutable` because a content-addressed blob can never change, and
returns `410` once a release is paused or rolled back, even to a device holding a valid token. A
token belongs to one release, works for all of that release's files for 30 minutes by default, and
is only accepted in the header (`?token=` is refused). The release's signed manifest must list
the file being requested.

`/ota/v1/*` is retired. `POST /ota/v1/check` and `POST /ota/v1/enroll` answer `200` with no update
and a `hard` native policy, so old clients show their update-from-the-store prompt; the store link is
included only if you've set one with `native-policy`. `GET /ota/v1/download` and
`POST /ota/v1/confirm` answer `410 retired`. The check and enroll requests are counted per channel
and platform (valid values only) so you can see how many installs are still on a pre-v2 binary.

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

Plus `GET`/`HEAD /health` (liveness: `{"ok":true}`, never touches storage) and `GET`/`HEAD /ready`
(readiness: `{"ready":true,"releases":N}`, or `503` when the store can't be reached).

`/admin/native-policy` validates its body: `channel` must be a valid channel name,
`minSupportedNativeVersion` a whole number of 0 or more, `severity` `soft` or `hard`, and `storeUrl`
(optional) a URL starting with `https://`, `market://` or `itms-apps://`, with no user name or
password part and no spaces or control characters. That limits the scheme; it doesn't stop an
`https://` link to someone else's site. Clients from 0.5.0 ignore the server's link and use their
own `config.storeUrl`, because the policy isn't covered by the manifest signature. See
[If your update server is breached](/docs/security/breach).

## Publishing takes three steps

Devices never see a release until it is finalized, so an interrupted publish is never half-live.
The CLI's `publish` creates a new `bundleId` on each run; the unfinished release stays in `list` as
`INCOMPLETE` and is never offered.

```
POST /admin/releases            → { bundleId, missing: [sha, ...] }
PUT  /admin/releases/:id/blobs/:sha   (once per missing blob)
POST /admin/releases/:id/finalize
```

`missing[]` is usually far shorter than the file list, because files are shared across releases: an
unchanged asset is already in the store. Publishing a release that changes one asset typically
uploads two blobs: that asset and the JS bundle.

A finalized release can't be changed: publishing the same `bundleId` again returns `409`. Publish a
new `bundleVersion` instead.

## Errors

Errors are JSON: `{ "error": "<message>", "code": "<code>" }`. The ones you're most likely to
meet:

| Status | Code | When |
|---|---|---|
| 400 | `bad_request` | malformed or empty JSON, or a field that fails validation |
| 401 | `not_enrolled`, `bad_signature`, … | a device request whose signature, timestamp or nonce doesn't check out |
| 403 | `forbidden`, `bad_token` | wrong or missing admin token; a download token that is invalid, expired or for another release |
| 409 | `already_published` | the `bundleId` is already finalized |
| 410 | `gone`, `retired` | the release is paused or rolled back, or a retired v1 route |
| 413 | `too_large` | a body over its limit: 64 KiB for device requests, `maxAdminBodyBytes` for admin ones, `maxBlobBytes` for one file |
| 429 | `rate_limited` | a rate limit; see `Retry-After` |
| 503 | `admin_disabled` | no admin token is configured |

The full list is in the [protocol reference](https://github.com/Scripting-Bear/dash-ota/blob/main/docs/PROTOCOL.md).

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

It's made with the device's own private key (hardware-backed where the device supports it). The
backend checks it against the public key registered at `/enroll`, then checks the timestamp window,
then records the nonce and rejects any reuse. The path is signed without its query string.
[`react-native-dash-ota`](/docs/react-native/use-ota-update) does all of this for you.

→ [Request-signing internals](/docs/architecture/request-signing)
