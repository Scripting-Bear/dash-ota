# dash-ota — Backend Implementation Guide for gotradeIndia

**Audience:** the gotradeIndia backend team (and the AI agent building it in their codebase).
**Goal:** stand up the OTA distributor that serves signed JS bundles to the gotradeIndia app, wired
to gotradeIndia's own auth, infra, and channels — replacing Stallion.

This guide is self-contained. The normative wire contract is [`PROTOCOL.md`](./PROTOCOL.md); read it
if you re-implement rather than drop in the package. Everything the client (the app) does is already
built — **the backend is the only missing piece**, and this document is how to build it.

---

## 0. TL;DR / what the backend must do

The dash-ota backend is **stateless trust-wise**: it never holds the signing private key and can
never forge an update. It:

1. Registers each device's **hardware public key** at `/ota/v1/enroll` — gated by **your** session auth.
2. Answers `/ota/v1/check` with the best eligible **pre-signed** release for a device (runtimeVersion
   + channel + rollout + downgrade rules), authenticated by the device's ECDSA signature.
3. Serves the encrypted bundle bytes at `/ota/v1/download` via a one-time token.
4. Records apply results at `/ota/v1/confirm` (adoption + automatic rollout pause on failures).
5. Exposes admin endpoints for the **CLI/CI** to publish releases and operate rollouts.

**Recommended path: drop in the Node package `@dash-ota/backend`** and configure providers + one
auth hook. Estimated effort: a few hours. If you can't run Node, re-implement the protocol (§7).

---

## 1. Decide your integration path

| | Path A — drop in `@dash-ota/backend` (recommended) | Path B — re-implement `PROTOCOL.md` |
|---|---|---|
| When | You can run a Node service (or mount into an existing Node/Express app) | Your backend is Go/Java/etc. and you won't add Node |
| Effort | Config + one auth hook | Full server, must match every invariant in PROTOCOL.md |
| Risk | Low — the crypto/targeting/anti-replay core is tested | Higher — you own the security-critical logic |

The rest of this guide is **Path A**. Path B is §7.

---

## 2. Path A — install & mount

```bash
npm i @dash-ota/backend
# optional peers, only for the adapters you use (see §4):
npm i pg ioredis @aws-sdk/client-s3        # Postgres + Redis + S3
```

**Mount into an existing Express app** (mount at the ROOT — the routes are absolute and the device
signs over the path, so a sub-path breaks signature verification):

```ts
import express from 'express';
import { dashOtaMiddleware, rawBodySaver } from '@dash-ota/backend';

const app = express();
// The OTA request signature is over the RAW body — keep the bytes if a JSON parser runs first.
app.use(express.json({ verify: rawBodySaver }));

app.use(
  dashOtaMiddleware({
    adminToken: process.env.OTA_ADMIN_TOKEN,           // required — no default (see §6)
    databaseUrl: process.env.OTA_DATABASE_URL,          // Postgres (else disk)
    redisUrl: process.env.OTA_REDIS_URL,                // Redis (REQUIRED if >1 instance)
    s3Bucket: process.env.OTA_S3_BUCKET,                // S3/R2 (else disk)
    verifyEnrollToken: gotradeVerifyEnroll,             // ← the one integration point (§3)
    onConfirm: (e) => metrics.track('ota_confirm', e),  // observability (§8)
    onPublish: (e) => metrics.track('ota_publish', e),
  }),
);
```

**Or run standalone** (no Express): `createOtaBackend({ ... }).listen(4455)`.

That's the whole integration. The rest is configuration.

---

## 3. The one integration point: `verifyEnrollToken`

`installId` is a **non-secret, client-chosen** value, and enroll registers/overwrites the device's
signing key. So **enrollment MUST be bound to an authenticated gotradeIndia user session** — this is
the single most important thing to get right. Without it, anyone who knows an `installId` could
enroll it with their own key and impersonate the device.

The app sends its gotradeIndia session token as `enrollToken`. Verify it against your session
service and decide whether to allow the device to register its key:

```ts
import type { EnrollPrincipal } from '@dash-ota/backend';

async function gotradeVerifyEnroll(token: string | undefined, principal: EnrollPrincipal): Promise<boolean> {
  if (!token) return false;
  const session = await gotrade.auth.verifySession(token); // your existing session check
  if (!session?.userId) return false;

  // Optional stronger gating — both are surfaced by the client:
  //   principal.attestationToken  → Play Integrity / App Attest token (verify server-side)
  //   principal.keyHardwareBacked → true if the key is in StrongBox/TEE/Secure Enclave
  // e.g. require hardware-backed keys in prod:
  if (principal.channel === 'prod' && principal.keyHardwareBacked === false) return false;

  // (Recommended) record userId ↔ installId so you can revoke a user's OTA device later.
  await gotrade.db.linkOtaInstall(session.userId, principal.installId);
  return true;
}
```

> Set `requireEnrollAuth: true` (the default). Never ship the presence-only fallback to production.

The app does **not** need a shared secret — it authenticates every `/check`/`/confirm` with its
hardware key. `verifyEnrollToken` is the only place your auth meets dash-ota.

---

## 4. Storage providers (your infra)

Defaults are disk + in-memory (single node, zero config). For gotradeIndia production, wire real
infra with a URL each — the driver loads lazily; nothing else changes. Full details:
[Storage providers & adapters](../website/docs/backend/providers.md).

| Concern | Provider | gotradeIndia choice | Env |
|---|---|---|---|
| Release/install metadata | `DatabaseProvider` | **Postgres** (or SQLite for single node) | `OTA_DATABASE_URL` |
| Encrypted bundle bytes | `BlobStore` | **S3 / your object store** | `OTA_S3_BUCKET` (+ `OTA_S3_*`) |
| Nonces / tokens / rate-limit | `CacheProvider` | **Redis** | `OTA_REDIS_URL` |

:::important Multi-instance
If you run **more than one replica** (you will), you **must** set `OTA_REDIS_URL`. The anti-replay
guard, one-time download tokens, and rate limiting live in the cache; the in-memory default is
per-process and would let a replay slip through on another replica.
:::

Advanced (custom clients — Cluster/Sentinel/pooled): inject providers directly via `providers: { db,
cache, blob }` instead of the URLs. See the providers doc.

---

## 5. Channels & runtimeVersion

- **Channels** map to gotradeIndia's build flavours: `dev` / `uat` / `prod`. A release is published
  to one channel; a device only sees its own channel's releases. The app's channel is embedded
  natively per flavour (`OTA_CHANNEL`), not chosen by JS.
- **runtimeVersion** is the native-compatibility key. An OTA is eligible **only** for a binary with
  the **exact same `runtimeVersion`** — this is what stops a JS bundle built for one native
  generation from loading on an incompatible one (the bug most OTA tools get wrong). The CLI computes
  it from the native project (`dash-ota fingerprint`), or you set it explicitly per store release.
  **Bump `runtimeVersion` whenever you ship a store build with changed native code/deps**, so old
  OTAs don't target the new binary and vice-versa. The backend enforces the match; the native client
  enforces it again before applying (defense in depth).

The backend does not choose these — it serves what the CLI published for `{platform, channel,
runtimeVersion}`. Your job is to run the service; the release lifecycle is the CLI's (§9).

---

## 6. Secrets, TLS & posture

- **`OTA_ADMIN_TOKEN`** — the CLI/CI credential for `/admin/*`. **No default**; if unset, all admin
  endpoints return `503` (fail-closed). Store it in your secrets manager; rotate on suspicion. It is
  **not** the signing key.
- **The signing private key is never on the backend.** It lives in CI/KMS and signs releases via the
  CLI. A full backend compromise still cannot forge an update.
- **TLS**: serve everything over HTTPS; serve `/admin/*` only over HTTPS. Terminate at your gateway
  and forward to the service at the **root**. Set `client_max_body_size` ≥ `OTA_MAX_BUNDLE_BYTES`
  (default 100 MiB) for `/admin/publish`.
- **Rate limiting**: per-install limits on `/enroll`+`/check` are built in; put IP/WAF flood
  protection at your gateway.
- **Health probes**: `GET /health` = liveness (never touches storage — don't let a DB blip restart
  the pod); `GET /ready` = readiness (503 when the store is unreachable — pull it from rotation).

Deployment reference (docker-compose + nginx + probes):
[ops](../website/docs/backend/ops.md).

---

## 7. Path B — re-implement the protocol

Only if you won't run Node. Implement [`PROTOCOL.md`](./PROTOCOL.md) exactly. The security-critical
invariants you **must** preserve:

- **Auth**: verify the device ECDSA-P256 signature over the canonical string
  `METHOD\npath\ninstallId\nnonce\ntimestamp\nbodySha256` (path = pathname, no query). Verify the
  signature **before** recording the nonce. Reject a reused nonce and a timestamp outside the skew.
- **Enroll**: gate with your session auth (§3). Store the device SPKI-DER public key per install.
- **Eligibility**: exact `runtimeVersion` match, same platform+channel, `bundleVersion > current`
  (downgrade guard), targeting rules, `rolloutBucket = sha256(installId+bundleId) % 100 <
  rolloutPercentage`, not paused/rolled-back, highest `bundleVersion` wins.
- **Download**: serve ciphertext only via a **one-time, short-TTL token** (never expose the object
  URL). Set `Content-Length` = the signed `ciphertextSize`.
- **Server nonce**: bind the nonce returned by `/check` to `{installId, bundleId}`; require both on
  `/confirm` (else a device could confirm-fail a bundle it was never offered and trip auto-pause).
- **Publish**: verify the manifest's Ed25519 signature against a registered public key, validate its
  shape, and cross-check the ciphertext hash **and** size against the manifest.
- **Auto-pause**: when `total ≥ autoPauseMinSamples` and `(failed+rolled_back)/total ≥
  autoPauseFailureRate`, pause the rollout.

Use the `@dash-ota/backend` test suites (`e2e.test.ts`, `express.smoke.test.ts`) as your conformance
spec — they encode these as executable checks.

---

## 8. Observability

Wire the hooks to gotradeIndia's metrics/alerting:

- `onPublish({ bundleId, platform, channel, bundleVersion, runtimeVersion, rolloutPercentage })` —
  a release went live.
- `onConfirm({ installId, bundleId, status, reason, autoPaused })` — per-device apply result;
  `status ∈ applied|healthy|failed|rolled_back`. **Alert on `autoPaused: true`** (a rollout tripped
  the failure breaker) and on a rising `failed`/`rolled_back` rate.
- `GET /admin/releases` returns adoption/health per release for a dashboard.
- `logger` — pass your logger; it never logs tokens/keys/PII.

---

## 9. Release lifecycle (CLI/CI — for context)

The backend serves; **releases are produced by the CLI** (`@dash-ota/cli`) in CI, holding the signing
key. Typical prod flow:

```bash
# once: generate + register the signing key (private key → CI secret, public key embedded in the app)
dash-ota keygen --key-id key_prod_1                        # encrypts the private key at rest
dash-ota register-key --key-id key_prod_1 --key-file .keys/key_prod_1.public.json \
  --server https://ota.gotradeindia.com --admin-token "$OTA_ADMIN_TOKEN"

# per release:
dash-ota bundle  --platform android --out ./out --hermes   # HBC
dash-ota publish --bundle-dir ./out --platform android --channel prod \
  --runtime-version auto --bundle-version 42 --rollout 10 \
  --key-id key_prod_1 --server https://ota.gotradeindia.com --admin-token "$OTA_ADMIN_TOKEN"
dash-ota rollout --bundle-id <id> --pct 100                 # ramp when healthy
```

The backend just needs the signing **public** key registered (via `register-key`) and the CLI
pointed at it. See the [CLI docs](../website/docs/cli/commands.md).

---

## 10. Migrating from Stallion

- **Model shift**: Stallion is a hosted service; dash-ota is **self-hosted** and **integrity-signed
  in native** — a breached backend can't push code to your users. There is no vendor to trust.
- **Per-env isolation** maps directly: Stallion's environments → dash-ota channels (dev/uat/prod),
  embedded per flavour.
- **Cutover** (safe, no user disruption):
  1. Ship a store build that embeds dash-ota (public keys + `OTA_SERVER_URL` + `runtimeVersion`) and
     **still contains** the current JS as the baseline bundle. Keep Stallion for older installs.
  2. Stand up the backend (this guide) at `https://ota.gotradeindia.com`.
  3. Publish the first OTA to `dev`, verify on internal devices, then `uat`, then `prod` at a low
     rollout %, ramping as adoption/health look good.
  4. Once the dash-ota-enabled build is the floor across the user base, retire Stallion.
- **Force-update parity**: use the native-policy gate (`dash-ota native-policy`) for "must update the
  store build" situations — the OTA channel serves JS; native changes still need a store release.

---

## 11. Acceptance checklist (definition of done)

Ordered steps for the implementing agent. Each is verifiable.

1. [ ] `@dash-ota/backend` mounted at the app root; `GET /health` → `{ ok: true }`.
2. [ ] `OTA_ADMIN_TOKEN` set from secrets; with it unset, `/admin/*` → `503` (verify fail-closed).
3. [ ] `verifyEnrollToken` wired to gotradeIndia sessions; a bad/absent session → enroll `401`; a
       valid session → `200`. Record `userId ↔ installId`.
4. [ ] Providers wired: `OTA_DATABASE_URL` (Postgres), `OTA_S3_BUCKET` (object store),
       `OTA_REDIS_URL` (Redis — **mandatory for >1 replica**). `GET /ready` → `200` when all reachable,
       `503` when not.
5. [ ] TLS everywhere; gateway forwards to root; `client_max_body_size` ≥ `OTA_MAX_BUNDLE_BYTES`;
       WAF/IP flood protection on `/enroll`+`/check`.
6. [ ] CLI can `register-key` + `publish` against the deployed URL (admin token accepted).
7. [ ] Observability: `onPublish`/`onConfirm`/`GET /admin/releases` feeding metrics; **alert on
       `autoPaused`**.
8. [ ] **QA gates before prod traffic:**
   - Automated: run the package's `npm run ci` + adapter integration tests against your **real**
     Postgres/Redis/S3 (set `OTA_TEST_DATABASE_URL` / `OTA_TEST_REDIS_URL` / `OTA_TEST_S3_BUCKET`).
   - On-device: on a real Android + iOS build, run the full loop — enroll → check → download →
     native verify → apply → confirm; tamper → reject; crash-loop → revert; runtimeVersion gate;
     **and if you enable TLS pinning, verify the pin on-device before shipping (a wrong pin bricks
     OTA)**.
   - Security: re-run the threat model against your deployment (secrets, TLS, enroll gating).
9. [ ] Runbook: how to pause/rollback a bad release (`dash-ota pause|rollback`), rotate the admin
       token, and rotate the signing key (key-ring transition build).

---

### Reference index
- Wire protocol (normative): [`PROTOCOL.md`](./PROTOCOL.md)
- Providers/adapters: [providers](../website/docs/backend/providers.md)
- Deployment/ops: [ops](../website/docs/backend/ops.md)
- Security model + honest limitations: [`website/docs/security/`](../website/docs/security/)
- CLI (release lifecycle): [commands](../website/docs/cli/commands.md), [key custody](../website/docs/cli/key-custody.md)
