# dash-ota Wire Protocol — v1

The contract between a dash-ota **client** (the RN app + native module) and a dash-ota
**backend** (the distributor). It is small, JSON-over-HTTPS, and stack-agnostic: the reference
backend is `@dash-ota/backend` (Node), but any server that honours this spec is conformant, and
any client that honours it interoperates.

- **Protocol version:** `v1` (URL prefix `/ota/v1`).
- **Manifest schema:** `1` (the `schema` field; bump on any breaking manifest shape change).
- **Source of truth:** the types in `@dash-ota/shared` (`protocol.ts`, `manifest.ts`,
  `targeting.ts`, `request.ts`, `canonical.ts`). This document must match them.

---

## 1. Trust model (what a conformant backend MUST / MUST NOT do)

- **MUST NOT** hold any signing private key. The backend only stores and serves **pre-signed**
  manifests + AES-GCM ciphertext produced by the CLI/CI.
- **MUST NOT** mint or alter a manifest. On `/admin/publish` it MUST verify the manifest's
  Ed25519 signature against a registered public key and reject on mismatch, and MUST verify the
  ciphertext SHA-256 equals `manifest.encryption.ciphertextSha256`.
- **MUST** enforce eligibility server-side (§6) — above all the exact `runtimeVersion` gate — so a
  compromised or buggy client can never be *offered* a cross-generation bundle.
- **MUST** authenticate `/check` + `/confirm` with the device key (§4) and reject replays.
- **MUST** serve ciphertext only via a one-time, short-TTL download token — never expose a
  storage (S3) URL to the client.
- Integrity is guaranteed by the client's **native Ed25519 verification** against an embedded
  key; a fully-compromised backend can at worst serve a validly-signed *older* bundle, which the
  client's downgrade guard rejects.

---

## 2. Transport & encoding

- HTTPS only. All request/response bodies are JSON (`Content-Type: application/json`), except
  `GET /ota/v1/download` which returns `application/octet-stream`.
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

After enrollment the device holds a **non-exportable hardware key** (AndroidKeyStore / Secure
Enclave, EC P-256). There is **no shared secret**. `/check` and `/confirm` MUST be signed; the
backend verifies against the public key registered at `/enroll`.

**Headers:**

| Header | Meaning |
|---|---|
| `x-ota-install` | the install id |
| `x-ota-nonce` | fresh per-request nonce (base64, CSPRNG) |
| `x-ota-timestamp` | unix epoch **ms**, decimal string |
| `x-ota-signature` | ECDSA-P256-SHA256 signature, DER-encoded, base64 |

**Canonical signing string** (newline-joined, exact field order):

```
<METHOD>\n<path>\n<installId>\n<nonce>\n<timestamp>\n<bodySha256>
```

- `<METHOD>` upper-case (`POST`).
- `<path>` the request **pathname** — exactly what the backend verifies (`ctx.path`, no query
  string). The signed endpoints (`/ota/v1/check`, `/ota/v1/confirm`) carry no query; `/download`
  is token-authenticated, not signed.
- `<bodySha256>` lowercase hex SHA-256 of the **raw** request body bytes (the SHA-256 of the empty
  buffer for an empty body). The backend MUST hash the raw bytes it received — if a JSON body
  parser runs first, the raw bytes must be preserved (the Node adapter uses `rawBodySaver`).

**Verification (backend):**

1. Require `x-ota-install`; if request signing is enabled, require the other three headers.
2. Reject if `|now − timestamp| > timestampSkewMs` (default 5 min) → `401 stale_timestamp`.
3. Register the nonce; if already seen within `nonceTtlMs` → `401 replay`.
4. Look up the install's device public key (SPKI-DER, base64); if absent → `401 not_enrolled`.
5. `ecdsaVerify(devicePubKey, signingString, signature)`; on failure → `401 bad_signature`.

**Admin auth:** admin routes require header `x-ota-admin-token` equal to the configured admin
token (a constant-time compare is REQUIRED). Missing/wrong → `403 forbidden`.

---

## 5. Endpoints

### `GET /health`
Liveness. `200 { "ok": true, "releases": <count> }`. No auth.

### `POST /ota/v1/enroll`
Register the device's **public** key (called once; re-call to rotate). Auth: `enrollToken`
(the app's authenticated session), validated by the backend's `verifyEnrollToken` hook.

```jsonc
// request (EnrollRequest)
{ "installId": "…", "platform": "android|ios", "channel": "dev|uat|prod",
  "appVersion": "1.2.0", "buildNumber": 10,
  "devicePublicKeyB64": "<SPKI-DER base64 of the EC P-256 public key>",
  "enrollToken": "<app session token>" }
// response 200 → { "ok": true }
// 400 invalid body · 401 unauthenticated (enroll session rejected)
```
No secret is issued or returned — nothing to intercept at enrollment.

### `POST /ota/v1/check`  *(signed, §4)*
Ask for an eligible update.

```jsonc
// request (CheckRequest)
{ "installId": "…", "platform": "android", "channel": "prod",
  "runtimeVersion": "<binary's embedded runtimeVersion>",
  "appVersion": "1.2.0", "buildNumber": 10, "currentBundleVersion": 6 }
// response 200 (CheckResponse)
{ "update": <SignedManifest> | null,        // null = no update
  "downloadToken": "<one-time token>",       // present only when update != null
  "serverNonce": "<echo on /confirm>",       // always present
  "nativePolicy": { "minSupportedNativeVersion": 0, "severity": "none|soft|hard", "storeUrl?": "…" } }
```
The backend applies §6 eligibility + rollout and returns the highest-`bundleVersion` match, or
`update: null`. `serverNonce` is single-use and bound to this install.

### `GET /ota/v1/download`  *(one-time token)*
Stream the ciphertext archive. Token via `x-ota-download-token` header or `?token=`.

```
200 application/octet-stream  <ciphertext bytes>   (Content-Length set)
403 bad_token   (missing / expired / already used)
404 not_found   (ciphertext missing)
```
The response is **streamed** (the backend never buffers the whole ciphertext) and carries a
`Content-Length` equal to the signed `encryption.ciphertextSize`, so the client can pre-check the
size before reading the body. The token is single-use and short-TTL (`downloadTokenTtlMs`, default
2 min). The client verifies
`ciphertextSha256`, the Ed25519 signature, then per-file hashes **natively** before applying.

### `POST /ota/v1/confirm`  *(signed, §4)*
Report the apply outcome (drives adoption + server-side auto-pause).

```jsonc
// request (ConfirmRequest)
{ "installId": "…", "bundleId": "…", "runtimeVersion": "…",
  "status": "applied|healthy|failed|rolled_back",
  "serverNonce": "<from the matching /check>", "reason?": "no PII" }
// response 200 → { "ok": true, "autoPaused": <bool> }
// 401 bad_nonce (serverNonce not issued to this install / already used)
```

### Admin routes *(all require `x-ota-admin-token`)*

| Method · Path | Body → effect |
|---|---|
| `POST /admin/keys` | `{ keyId, publicKeyRawB64 }` → register a trusted signing public key |
| `POST /admin/publish` | `{ signedManifest, ciphertextB64, rolloutPercentage? }` → verify sig + ciphertext hash, store the release |
| `GET /admin/releases` | → list releases with rollout/pause/adoption state |
| `POST /admin/rollout` | `{ bundleId, rolloutPercentage }` → set rollout % (clamped 0–100) |
| `POST /admin/pause` | `{ bundleId, paused }` → pause/unpause |
| `POST /admin/rollback` | `{ bundleId }` → mark rolled-back (+ pause) |
| `POST /admin/native-policy` | `{ channel, minSupportedNativeVersion, severity, storeUrl? }` → set the force-update gate |

`/admin/publish` MUST reject: unknown `keyId` (`400 unknown_key`), bad manifest signature
(`400 bad_signature`), ciphertext hash ≠ manifest (`400 hash_mismatch`), ciphertext size ≠
manifest `encryption.ciphertextSize` (`400 size_mismatch`), and ciphertext larger than the
configured cap `maxBundleBytes` (`413 too_large`).

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
`(failed + rolled_back) / total >= autoPauseFailureRate`, the rollout is paused automatically.

**Native-version policy (force-update):** `/check` returns `nativePolicy`. `severity` is `none`
when `device.buildNumber >= minSupportedNativeVersion` for the channel, else the configured
`soft` (dismissible nudge) or `hard` (blocking "update from store" gate).

---

## 7. The signed Manifest (schema 1)

The CLI Ed25519-signs `canonicalBytes(manifest)`; `keyId` + `signatureB64` live **outside** the
signed object.

```jsonc
// SignedManifest
{ "manifest": { /* Manifest, below */ },
  "signatureB64": "<Ed25519 signature over canonicalBytes(manifest)>",
  "keyId": "<copy of manifest.keyId>" }

// Manifest
{ "schema": 1,
  "bundleId": "bnd_…",              // globally unique
  "runtimeVersion": "R2",           // native-compat key (exact-match gate)
  "bundleVersion": 7,               // monotonic within a runtimeVersion (downgrade guard)
  "platform": "android",            // ios | android
  "channel": "prod",                // dev | uat | prod
  "createdAt": "2026-01-01T00:00:00.000Z",
  "mandatory": false,
  "minNativeBuild": 12,             // optional force-update hint
  "targetAppVersions": ">=1.2.0 <1.3.0",  // optional
  "files": [ { "path": "index.android.bundle", "sha256": "<hex>", "size": 12345 } ],
  "encryption": {
    "algo": "AES-256-GCM",
    "ivB64": "…", "tagB64": "…",
    "contentKeyB64": "…",           // AES-256 key (see confidentiality note)
    "ciphertextSha256": "<hex>",    // verified before decrypt
    "ciphertextSize": 45678 },
  "releaseNotes": "…",              // optional "What's New"
  "keyId": "key_prod_1" }
```

- `files[].sha256` / `.size` are of the **plaintext** file; verified per-file natively after
  decrypt. `encryption.ciphertextSha256` / `.ciphertextSize` are of the encrypted archive;
  verified before decrypt.
- **Confidentiality note:** in v1 `contentKeyB64` rides the TLS `/check` response, so AES-GCM
  gives confidentiality against passive sniffing / at-rest but **not** an active MITM until TLS
  pinning is enabled. **Integrity never depends on the content key** — that is the Ed25519
  signature verified natively.

---

## 8. Error codes

Errors are `{ "error": "<message>", "code": "<code>" }` with an HTTP status.

| Code | Status | Meaning |
|---|---|---|
| `unauthenticated` | 401 | missing install id / signature headers, or enroll session rejected |
| `stale_timestamp` | 401 | request timestamp outside the skew window |
| `replay` | 401 | request nonce already seen |
| `not_enrolled` | 401 | install has no registered device key |
| `bad_signature` | 401 / 400 | bad request signature (401) or bad manifest signature on publish (400) |
| `bad_nonce` | 401 | server nonce not issued to this install / already used |
| `forbidden` | 403 | missing / wrong admin token |
| `admin_disabled` | 503 | admin endpoints disabled — no admin token configured (fail-closed) |
| `bad_token` | 403 | download token missing / expired / already used |
| `not_found` | 404 | ciphertext missing |
| `unknown_key` | 400 | publish referenced an unregistered signing keyId |
| `hash_mismatch` | 400 | ciphertext hash ≠ manifest.encryption.ciphertextSha256 |
| `size_mismatch` | 400 | ciphertext size ≠ manifest.encryption.ciphertextSize |
| `too_large` | 413 | ciphertext exceeds the configured `maxBundleBytes` cap |
| `internal` | 500 | unexpected server error |

---

## 9. Conformance checklist

A backend is conformant if it: verifies device-key signatures + rejects replays and stale
timestamps (§4); enforces §6 eligibility (exact runtimeVersion, downgrade guard, targeting,
rollout bucketing) and highest-`bundleVersion` selection; verifies manifest signature + ciphertext
hash on publish (§5); serves ciphertext only via one-time tokens; never holds a signing key; and
returns the shapes + error codes above. The `@dash-ota/backend` e2e suite exercises each of these.
