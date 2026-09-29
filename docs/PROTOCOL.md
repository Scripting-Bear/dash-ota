# dash-ota Wire Protocol — v2

The contract between a dash-ota **client** (the RN app + native module) and a dash-ota
**backend** (the distributor). It is small, JSON-over-HTTPS, and stack-agnostic: the reference
backend is `@dash-ota/backend` (Node), but any server that honours this spec is conformant, and
any client that honours it interoperates.

- **Protocol version:** `v2` (URL prefix `/ota/v2`). A release is a set of content-addressed
  blobs, one per distinct file. `/ota/v1/*` answers only with a tombstone telling pre-v2 clients to
  update from the store.
- **Manifest schema:** `2` (the `schema` field; bump on any breaking manifest shape change).
- **Source of truth:** the types in `@dash-ota/shared` (`protocol.ts`, `manifest.ts`,
  `targeting.ts`, `request.ts`, `canonical.ts`). This document must match them.

---

## 1. Trust model (what a conformant backend MUST / MUST NOT do)

- **MUST NOT** hold any signing private key. The backend only stores and serves **pre-signed**
  manifests and blobs produced by the CLI/CI.
- **MUST NOT** mint or alter a manifest. On `/admin/releases` it MUST verify the manifest's
  Ed25519 signature against a registered public key and reject on mismatch, and it MUST verify
  that each uploaded blob hashes to the `blob.sha256`, and has the `blob.size`, the signed manifest
  names.
- **MUST** enforce eligibility server-side (§6) — above all the exact `runtimeVersion` gate — so a
  compromised or buggy client can never be *offered* a cross-generation bundle.
- **MUST** authenticate `/check` + `/confirm` with the device key (§4) and reject replays.
- **MUST** serve blobs only via a short-TTL download token scoped to one release and sent in a
  header — never expose a storage (S3) URL to the client.
- Integrity is guaranteed by the client's **native Ed25519 verification** against embedded keys: a
  fully-compromised backend can never forge or modify a release. It **can**, however, re-serve any
  previously-published *validly-signed* release whose `bundleVersion` is higher than the bundle a
  device is running now. The downgrade guard compares against the running bundle only and persists
  nothing, so after a store update, a client `rollback()` or a crash-loop revert, older releases
  qualify again. `paused` / `rolledBack` are **server-side-only** mutable state, not signed, so they
  are not a revocation guarantee against a rogue backend. The crash-loop breaker is the client-side
  backstop for a re-served release that crashes.
- Everything in the `/check` response outside `update` is unsigned: whether an update is offered,
  `nativePolicy`, `downloadToken` and `serverNonce`. A rogue backend can withhold updates and send
  `severity: "hard"`. Clients 0.5.0 and later ignore `nativePolicy.storeUrl` and use the app's own
  configured store link.

---

## 2. Transport & encoding

- HTTPS only. All request/response bodies are JSON (`Content-Type: application/json`), except
  `GET /ota/v2/releases/{bundleId}/blobs/{blobSha256}` which returns `application/octet-stream`
  and supports `Range`.
- Timestamps are ISO-8601 strings (manifest) or unix-epoch-**milliseconds** as a decimal string
  (request `x-ota-timestamp`).
- Binary values are base64 unless stated as hex.

---

## 3. Canonical JSON (the exact bytes that get signed)

Signatures are computed over **canonical** bytes so the signer (CLI) and verifier (native) agree
byte-for-byte. Canonicalization rules:

1. Object keys sorted **ascending, recursively**.
2. Arrays preserve order.
3. Compact separators — no insignificant whitespace (`JSON.stringify` of the sorted value).
4. `undefined` object values are omitted.
5. Non-finite numbers (`NaN`, `±Infinity`) are rejected.

`canonicalBytes(x) = UTF-8( JSON.stringify(sortKeysRecursive(x)) )`.

---

## 4. Request authentication (device key, ECDSA-P256)

After enrollment the device holds an EC P-256 key generated in the AndroidKeyStore or the iOS
Secure Enclave (iOS falls back to a software Keychain key unless `OTA_REQUIRE_HARDWARE_KEY` is set).
There is **no shared secret**. `/check` and `/confirm` MUST be signed; the backend verifies against
the public key registered at `/enroll`.

**Headers:**

| Header | Meaning |
|---|---|
| `x-ota-install` | the install id |
| `x-ota-nonce` | fresh per-request nonce (base64url of 16 bytes from the platform CSPRNG) |
| `x-ota-timestamp` | unix epoch **ms**, decimal string |
| `x-ota-signature` | ECDSA-P256-SHA256 signature, DER-encoded, base64 |

**Canonical signing string** (newline-joined, exact field order):

```
<METHOD>\n<path>\n<installId>\n<nonce>\n<timestamp>\n<bodySha256>
```

- `<METHOD>` upper-case (`POST`).
- `<path>` the request **pathname** — exactly what the backend verifies (`ctx.path`, no query
  string). The signed endpoints (`/ota/v2/check`, `/ota/v2/confirm`) carry no query; the blob route
  is token-authenticated, not signed.
- `<bodySha256>` lowercase hex SHA-256 of the **raw** request body bytes (the SHA-256 of the empty
  buffer for an empty body). The backend MUST hash the raw bytes it received — if a JSON body
  parser runs first, the raw bytes must be preserved (the Node adapter uses `rawBodySaver`).

**Verification (backend):**

1. Require `x-ota-install` (else `401 unauthenticated`); if request signing is enabled, require
   the other three headers (else `401 unauthenticated`).
2. Reject if `|now − timestamp| > timestampSkewMs` (default 5 min) → `401 stale_timestamp`.
3. Look up the install's device public key (SPKI-DER, base64); if absent → `401 not_enrolled`.
4. `ecdsaVerify(devicePubKey, signingString, signature)`; on failure → `401 bad_signature`.
5. Only for a valid signature, register the nonce; if already seen within `nonceTtlMs` (default
   10 min) → `401 replay`.

Registering the nonce last keeps forged requests out of the replay cache. `nonceTtlMs` MUST be at
least `2 × timestampSkewMs`; otherwise a request replayed after its nonce expires, while its
timestamp is still inside the window, is accepted.

**Admin auth:** admin routes require header `x-ota-admin-token` equal to the configured admin
token (a constant-time compare is REQUIRED). Missing/wrong → `403 forbidden`. No admin token
configured → `503 admin_disabled`.

**Body limits:** device and unauthenticated JSON bodies are capped at 64 KiB; an admin JSON body
may be up to `maxAdminBodyBytes` (default 32 MiB) once the admin token checks out. Over the cap →
`413 too_large`.

---

## 5. Endpoints

### `GET /health`
Liveness — process is up. `200 { "ok": true }`. No auth. MUST NOT touch dependencies (a liveness
probe must not fail just because the store is briefly unreachable).

### `GET /ready`
Readiness — can this instance serve? Touches the store. `200 { "ready": true, "releases": <count> }`
when the backing store is reachable, else `503 { "ready": false, "error": "store unreachable" }`.
No auth. Use this for load-balancer / orchestrator rotation.

### `POST /ota/v2/enroll`
Register the device's **public** key (called once; the client calls it again after a key change or
when `/check` answers `not_enrolled`). Not signed. Auth: `enrollToken`, validated by the backend's
`verifyEnrollToken` hook.

> **Enrollment MUST be gated.** `installId` is a **non-secret, client-chosen** value, and enroll
> overwrites the stored device key. A production backend **MUST** wire `verifyEnrollToken` to bind
> enrollment to an authenticated user session — otherwise anyone who knows a victim's `installId`
> can re-enroll it with their own key and impersonate the device. Without the hook,
> `requireEnrollAuth` only checks that `enrollToken` is non-empty; that is for local dev only.
> `attestationToken` and `keyHardwareBacked` are passed to the hook, but both come from the client:
> `keyHardwareBacked` is self-reported, and the attestation token is not bound to a server
> challenge.

```jsonc
// request (EnrollRequest)
{ "installId": "…", "platform": "android|ios", "channel": "dev|uat|prod",
  "appVersion": "1.2.0", "buildNumber": 10,
  "devicePublicKeyB64": "<SPKI-DER base64 of the EC P-256 public key>",
  "enrollToken": "<token from the app's getEnrollToken>",
  "attestationToken?": "<Play Integrity / App Attest token>",
  "keyHardwareBacked?": true }
// response 200 → { "ok": true }
// 400 bad_request · 401 unauthenticated (enroll session rejected) · 429 rate_limited
```
No secret is issued or returned. `/enroll` (by `installId`, with failed attempts counted per client
address instead) and `/check` (by the authenticated `installId`) are rate-limited with a fixed window
(`enrollRateLimit` / `checkRateLimit` per `rateLimitWindowMs`; `0` disables). The limiter is
backed by the `CacheProvider`, so a shared cache (Redis) enforces it across instances; the
in-memory default is per-process. Over-limit responses are `429` with a `Retry-After` header.
Cross-install / IP-based flood protection is out of scope here — put it at the reverse proxy.

### `POST /ota/v2/check`  *(signed, §4)*
Ask for an eligible update.

```jsonc
// request (CheckRequest)
{ "installId": "…", "platform": "android", "channel": "prod",
  "runtimeVersion": "<binary's embedded runtimeVersion>",
  "appVersion": "1.2.0", "buildNumber": 10, "currentBundleVersion": 6,
  "protocol": 2,
  "currentBundleId": "<running bundleId; empty for the embedded bundle>",
  "currentBundleSha256": "<hex SHA-256 of the running bundle; empty if unknown>" }
// response 200 (CheckResponse)
{ "update": <SignedManifest> | null,        // null = no update
  "downloadToken": "<download token>",       // present only when update != null
  "serverNonce": "<echo on /confirm>",       // always present
  "nativePolicy": { "minSupportedNativeVersion": 0, "severity": "none|soft|hard", "storeUrl?": "…" } }
```
The backend applies §6 eligibility + rollout and returns the highest-`bundleVersion` match, or
`update: null`. `channel` is whatever the client asks for, so any enrolled install can receive any
channel's manifest, content key included. `serverNonce` is bound to this install and to the
bundles this check covered (the one offered and the one the device reported running); `/confirm`
can spend it once per (bundle, status). Only `update` is signed.

### `GET /ota/v2/releases/{bundleId}/blobs/{blobSha256}`  *(download token)*
Stream one stored blob. Token via the `x-ota-download-token` header only; a `?token=` query
parameter is not accepted. Not signed with the device key: the token authorises it, and the signed
manifest authenticates the bytes.

```
200 application/octet-stream  <stored blob bytes>   (Content-Length set)
206 partial content for a Range request (Content-Range set)
403 bad_token    (missing / expired token)
403 token_scope  (token issued for a different release)
404 not_found    (unknown release, blob not in this release, or blob missing)
410 gone         (release paused or rolled back)
416 range not satisfiable
```
The response is **streamed** (the backend never buffers the whole blob) and carries a
`Content-Length` equal to the blob's stored size, which the signed manifest also records as
`blob.size`. Blobs are immutable, so responses are cacheable. The token is reusable for every blob
of its release until it expires (`downloadTokenTtlMs`, default 30 min). Before any download the
client has already verified the Ed25519 signature over the manifest; per blob it then checks the
size and hash, decrypts, decompresses, and checks each file's plaintext hash and size — all
**natively**, before anything is applied. Android resumes interrupted blobs with `Range`; iOS
downloads each blob whole.

### `POST /ota/v2/confirm`  *(signed, §4)*
Report the apply outcome (drives adoption + server-side auto-pause).

```jsonc
// request (ConfirmRequest)
{ "installId": "…", "bundleId": "…", "runtimeVersion": "…",
  "status": "applied|healthy|failed|rolled_back",
  "serverNonce": "<from the matching /check>", "reason?": "no PII" }
// response 200 → { "ok": true, "autoPaused": <bool> }
// 401 bad_nonce (serverNonce unknown or expired, issued to another install, not covering this
//               bundle, or already spent on this bundle and status)
```
A `failed` report is also accepted for a newer release on the same runtime as the check, since the
client reports a crash-loop revert only after reverting. Each install's `failed` / `rolled_back`
report counts once per release toward auto-pause (remembered for 30 days).

### Admin routes *(all require `x-ota-admin-token`)*

| Method · Path | Body → effect |
|---|---|
| `POST /admin/keys` | `{ keyId, publicKeyRawB64 }` → register a trusted signing public key |
| `POST /admin/releases` | `{ signedManifest, rolloutPercentage? }` → verify sig, store the record, reply `{ ok, bundleId, missing[] }` |
| `PUT /admin/releases/{bundleId}/blobs/{sha}` | raw body, streamed → verify it hashes to `sha` and matches the signed size, store it; reply `{ ok, already }` |
| `POST /admin/releases/{bundleId}/finalize` | make the release servable; reply `{ ok, bundleId, rolloutPercentage, already }` |
| `GET /admin/releases` | → list releases with rollout/pause/adoption state, plus retired-client counts |
| `GET /admin/releases/{bundleId}` | → one release record, including its signed manifest |
| `POST /admin/rollout` | `{ bundleId, rolloutPercentage }` → set rollout % (rounded, clamped 0–100) |
| `POST /admin/pause` | `{ bundleId, paused }` → pause/unpause |
| `POST /admin/rollback` | `{ bundleId }` → mark rolled-back and paused; nothing clears `rolledBack` |
| `POST /admin/native-policy` | `{ channel, minSupportedNativeVersion, severity: "soft"\|"hard", storeUrl? }` → set the force-update gate |

Publishing is three steps: create the release, upload each missing blob, finalize. A release is
never offered to devices until it is finalized, so an interrupted publish can be re-run.

- `POST /admin/releases` MUST reject: a structurally invalid manifest (`400 bad_manifest`), unknown
  `keyId` (`400 unknown_key`), bad manifest signature (`400 bad_signature`), total blob bytes above
  `maxBundleBytes` (`413 too_large`), and a `bundleId` that is already finalized
  (`409 already_published`).
- `PUT …/blobs/{sha}` MUST reject: an unknown release (`404 no_release`), a blob the manifest does
  not reference (`404 no_blob`), a body above `maxBlobBytes`, enforced as it arrives
  (`413 too_large`), a body that does not hash to `sha` (`400 hash_mismatch`), and a size other
  than the signed `blob.size` (`400 size_mismatch`).
- `POST …/finalize` MUST reject: an unknown release (`404 no_release`) and a release with blobs
  still missing (`409 incomplete`, with `missing[]`).

`storeUrl` MUST be an `https://`, `market://` or `itms-apps://` URL with no credentials or
whitespace (`400 bad_request`); a stored value that fails this check is dropped when served. Any
`https` host passes.

### Retired v1 routes

`POST /ota/v1/check` and `POST /ota/v1/enroll` answer `200 { "update": null, "serverNonce": "",
"nativePolicy": { "minSupportedNativeVersion": …, "severity": "hard", "storeUrl?": … } }`, so a
pre-v2 client shows its store prompt. `GET /ota/v1/download` and `POST /ota/v1/confirm` answer
`410 retired`.

---

## 6. Eligibility, rollout & auto-pause (invariants a conformant backend MUST preserve)

**`isEligible(manifest, device)`** — all must hold, checked in this order:

1. `manifest.platform === device.platform` (else `platform-mismatch`)
2. `manifest.channel === device.channel` (else `channel-mismatch`)
3. **`manifest.runtimeVersion === device.runtimeVersion`** — the load-bearing cross-generation
   gate (else `runtime-mismatch`)
4. `manifest.bundleVersion > device.currentBundleVersion` — downgrade guard (else `not-newer`)
5. if `manifest.minNativeBuild` set: `device.buildNumber >= minNativeBuild` (else `native-too-old`)
6. if `manifest.targetAppVersions` set: `device.appVersion` satisfies the range (else
   `app-version-excluded`)

**Rollout bucket** (deterministic, stable across checks so a device never flips mid-rollout):

```
rolloutBucket(installId, bundleId) = parseInt( sha256Hex(`${installId}:${bundleId}`).slice(0,8), 16 ) % 100
```
A release is served only if it is eligible, **not paused / not rolled-back**, and
`rolloutBucket < release.rolloutPercentage`. Among matches, the **highest `bundleVersion`** wins.

**`targetAppVersions`** is a whitespace-joined range of comparators (`>=1.2.0 <1.3.0`, `1.2.x`,
`1.2.3`, `*`); every comparator must hold. (Reference matcher is a semver subset — a production
backend MAY use a full `semver` implementation as long as results agree on the supported forms.)

**Server-side auto-pause:** each `/confirm` updates the release's adoption counters
(`applied|healthy|failed|rolled_back`). When `total >= autoPauseMinSamples` **and**
`(failed + rolled_back) / total >= autoPauseFailureRate` (defaults 5 and 0.2), the rollout is
paused automatically.

**Native-version policy (force-update):** `/check` returns `nativePolicy`. `severity` is `none`
when `device.buildNumber >= minSupportedNativeVersion` for the channel, else the configured
`soft` (dismissible nudge) or `hard` (blocking "update from store" gate). The client does not
recompute this and renders nothing itself; the host app decides what `soft` and `hard` look like.

**What the client re-checks natively** after verifying the signature: `schema`, `appId`,
`runtimeVersion`, and (client 0.5.1 and later) `channel`, `platform` and `minNativeBuild`, then
that `bundleVersion` is higher than the running bundle's. Rollout, pause state and `targetAppVersions` are
enforced by the server only.

---

## 7. The signed Manifest (schema 2)

The CLI Ed25519-signs `canonicalBytes(manifest)`; `signatureB64` and an envelope copy of `keyId`
live **outside** the signed object.

```jsonc
// SignedManifest
{ "manifest": { /* Manifest, below */ },
  "signatureB64": "<Ed25519 signature over canonicalBytes(manifest)>",
  "keyId": "<copy of manifest.keyId; the backend uses it to find the registered public key>" }

// Manifest
{ "schema": 2,
  "protocol": 2,
  "bundleId": "bnd_rt1_7_mumg5z84",  // globally unique
  "runtimeVersion": "rt1",          // native-compat key (exact-match gate)
  "bundleVersion": 7,               // must exceed the device's running bundle (downgrade guard)
  "platform": "android",            // ios | android
  "channel": "prod",                // dev | uat | prod
  "appId": "com.example.app",       // package name / bundle identifier
  "createdAt": "2026-01-01T00:00:00.000Z",
  "mandatory": false,
  "minNativeBuild": 12,             // optional; lower native builds are not offered it
  "targetAppVersions": ">=1.2.0 <1.3.0",  // optional
  "encryption": { "mode": "aes-256-gcm", "contentKeyB64": "…" },  // or { "mode": "none" }
  "files": [
    { "path": "index.android.bundle", "role": "bundle",
      "sha256": "<hex, plaintext>", "size": 12345,
      "blob": { "sha256": "<hex, stored bytes>", "size": 4567,
                "compression": "zstd",          // or "none"
                "ivB64": "…", "tagB64": "…" } } // present when encrypted
  ],
  "patches": [],                    // reserved for bytecode deltas
  "releaseNotes": "…",              // optional "What's New"
  "keyId": "key_prod_1" }
```

- `files[].sha256` / `.size` are of the **plaintext** file; verified per-file natively after
  decrypting and decompressing. Each `files[].blob` carries its own `sha256`, `size`,
  `compression`, `ivB64` and `tagB64`; its hash is verified before decrypting. The GCM additional
  authenticated data is the file's plaintext hash.
- The client accepts a manifest that verifies against **any** public key embedded in the binary;
  it does not use `keyId` to pick one.
- **Confidentiality note:** `contentKeyB64` is returned by `/check` to any enrolled install for the
  channel it asks about, and the `/check` request is made with JavaScript `fetch`, which native TLS
  pinning does not cover. AES-GCM therefore keeps blobs unreadable to someone who can read the blob
  store or a cache but not the manifests. It does not hide bundles from the backend operator, an
  enrolled install, an active MITM on `/check`, or anyone with access to device storage, where
  files are kept decrypted. **Integrity never depends on the content key** — that is the Ed25519
  signature verified natively.

---

## 8. Error codes

Errors are `{ "error": "<message>", "code": "<code>" }` with an HTTP status.

| Code | Status | Meaning |
|---|---|---|
| `bad_request` | 400 | body is not a JSON object or is missing required fields, or a malformed path |
| `unauthenticated` | 401 | missing install id / signature headers, or enroll session rejected |
| `stale_timestamp` | 401 | request timestamp outside the skew window |
| `not_enrolled` | 401 | install has no registered device key |
| `bad_signature` | 401 / 400 | bad request signature (401) or bad manifest signature on publish (400) |
| `replay` | 401 | request nonce already seen |
| `bad_nonce` | 401 | server nonce unknown, expired, for another install or bundle, or already spent |
| `forbidden` | 403 | missing / wrong admin token |
| `admin_disabled` | 503 | admin endpoints disabled — no admin token configured (fail-closed) |
| `bad_token` | 403 | download token missing or expired |
| `token_scope` | 403 | download token issued for a different release |
| `gone` | 410 | release paused or rolled back (blob download) |
| `retired` | 410 | `/ota/v1/download` or `/ota/v1/confirm`: the v1 format is no longer served |
| `not_found` | 404 | unknown route, release or blob |
| `bad_manifest` | 400 | publish: manifest fails structural validation |
| `unknown_key` | 400 | publish referenced an unregistered signing keyId |
| `already_published` | 409 | publish: that `bundleId` is already finalized |
| `no_release` | 404 | blob upload or finalize for an unknown `bundleId` |
| `no_blob` | 404 | blob upload for a blob the manifest does not reference |
| `hash_mismatch` | 400 | an uploaded blob does not hash to the `sha` it was PUT under |
| `size_mismatch` | 400 | an uploaded blob's size differs from the signed `blob.size` |
| `incomplete` | 409 | finalize while blobs are still missing (`missing[]` lists them) |
| `too_large` | 413 | body over its cap, blob over `maxBlobBytes`, or release over `maxBundleBytes` |
| `rate_limited` | 429 | per-install rate limit exceeded on `/enroll` or `/check` (see `Retry-After`) |
| `internal` | 500 | unexpected server error |

---

## 9. Conformance checklist

A backend is conformant if it: verifies device-key signatures + rejects replays and stale
timestamps (§4); enforces §6 eligibility (exact runtimeVersion, downgrade guard, targeting,
rollout bucketing) and highest-`bundleVersion` selection; verifies the manifest signature and every
blob's hash and size on publish (§5); serves blobs only via release-scoped download tokens; never
holds a signing key; and returns the shapes + error codes above. The `@dash-ota/backend` e2e suite exercises each of these.
