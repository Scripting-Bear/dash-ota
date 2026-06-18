# Backend integration — `@dash-ota/backend`

The dash-ota backend is a **config-driven, plug-and-play OTA distributor**. It serves
**pre-signed** manifests + AES-256-GCM ciphertext, enforces targeting / rollout / anti-replay,
and authenticates devices by their **hardware public key (ECDSA P-256)**. It **never signs and
never holds the signing key** — that lives only in the [CLI](./cli.md).

You can use it three ways, all sharing one route core:

1. **Mount into an existing Express/Connect app** (recommended) — one middleware.
2. **Umbrella factory** — own the store/config, get every adapter from one object.
3. **Standalone server** — zero-dependency `node:http`.

---

## Install

```bash
npm install @dash-ota/backend
# express is optional — only if you mount into an Express app
npm install express
```

---

## 1. Mount into Express / Connect (recommended)

`dashOtaMiddleware(options)` returns a standard `(req, res, next)` handler. It owns the OTA
routes and lets everything else fall through to your app, so it coexists with your routes.

```ts
import express from 'express';
import { dashOtaMiddleware, rawBodySaver } from '@dash-ota/backend';

const app = express();

// The OTA request signature is over the RAW body bytes. If a global JSON parser runs first,
// stash the raw bytes with rawBodySaver; otherwise mount the OTA middleware BEFORE any parser.
app.use(express.json({ verify: rawBodySaver }));

app.use(
  dashOtaMiddleware({
    adminToken: process.env.OTA_ADMIN_TOKEN,         // protects /admin/* (CLI/console)
    verifyEnrollToken: (token) => auth.verify(token), // your app-session auth (see Hooks)
    onConfirm: (e) => metrics.track('ota_confirm', e),
    logger: console,
  }),
);

app.listen(4455);
```

> **Mount at the root.** The routes are absolute (`/ota/v1/*`, `/admin/*`, `/health`). Do not
> mount under a sub-path, or the signed request `path` won't match what the client signed.

### Raw body — important

The device signs `[METHOD, path, installId, nonce, timestamp, sha256(body)]`, so the backend
must verify against the **exact** body bytes. Two supported setups:

- Mount `dashOtaMiddleware` **before** any body parser (it reads the stream itself), **or**
- Keep your global `express.json()` but add `verify: rawBodySaver` so the raw bytes are stashed
  on `req.rawBody`.

---

## 2. Umbrella factory

`createOtaBackend(options)` builds the store + routes once and exposes every adapter:

```ts
import { createOtaBackend } from '@dash-ota/backend';

const ota = createOtaBackend({ adminToken: process.env.OTA_ADMIN_TOKEN, logger: console });

app.use(ota.middleware);     // Express/Connect middleware
await ota.listen(4455);      // OR run standalone on node:http
// ota.store, ota.routes, ota.config are also exposed
```

## 3. Standalone server

```bash
# from the package (or your own entry):
OTA_ADMIN_TOKEN=… OTA_PORT=4455 node -e "require('@dash-ota/backend').createOtaBackend().listen()"
```

---

## Configuration

Everything is optional with safe defaults; pass only what you need. Each field also has an env
fallback (handy for the standalone server).

| Option | Env | Default | Meaning |
|---|---|---|---|
| `port` | `OTA_PORT` | `4455` | standalone listen port |
| `adminToken` | `OTA_ADMIN_TOKEN` | `dev-admin-token` | bearer for `/admin/*` (header `x-ota-admin-token`) |
| `storageDir` | `OTA_STORAGE_DIR` | `<pkg>/storage` | where encrypted bundles are stored |
| `dataDir` | `OTA_DATA_DIR` | `<pkg>/.data` | release/install metadata (JSON) |
| `timestampSkewMs` | `OTA_TS_SKEW_MS` | `300000` | allowed client clock skew |
| `downloadTokenTtlMs` | `OTA_DL_TTL_MS` | `120000` | one-time download token TTL |
| `nonceTtlMs` | `OTA_NONCE_TTL_MS` | `600000` | replay-nonce cache TTL |
| `autoPauseFailureRate` | `OTA_AUTOPAUSE_RATE` | `0.2` | failure rate that auto-pauses a rollout |
| `autoPauseMinSamples` | `OTA_AUTOPAUSE_MIN` | `5` | min confirms before auto-pause can trip |
| `requireRequestSignature` | `OTA_REQUIRE_SIG` | `true` | enforce device-key signature on `/check` + `/confirm` |
| `requireEnrollAuth` | `OTA_REQUIRE_ENROLL_AUTH` | `true` | require an enroll session token (see `verifyEnrollToken`) |

### Hooks (config-driven extension points)

```ts
dashOtaMiddleware({
  // Validate the device's enroll session token against your IdP/auth service.
  // Return true to allow the device to register its public key.
  verifyEnrollToken: async (token, principal) => {
    // principal = { installId, platform, channel, appVersion?, buildNumber? }
    return token ? await auth.verifySession(token) : false;
  },
  onConfirm: (e) => { /* { installId, bundleId, status, reason?, autoPaused } */ },
  onPublish: (e) => { /* { bundleId, platform, channel, bundleVersion, runtimeVersion, rolloutPercentage } */ },
  logger: { info, warn, error },   // defaults to no logging in the middleware
});
```

If `verifyEnrollToken` is omitted, enrollment falls back to a presence-only check gated by
`requireEnrollAuth`. **In production, always provide `verifyEnrollToken`** so a device key can
only be registered by an authenticated user session.

### Bring your own store

The default `Store` persists to disk (JSON + files). Swap it for Postgres/Redis/object storage
by implementing the same surface and passing it in:

```ts
import { Store } from '@dash-ota/backend';
dashOtaMiddleware({ store: new MyPostgresStore(config) });
```

---

## Endpoints

**Client** (device-key signed except enroll):

| Method | Path | Purpose |
|---|---|---|
| POST | `/ota/v1/enroll` | register the device's public key (gated by `verifyEnrollToken`) |
| POST | `/ota/v1/check` | get an eligible update (manifest + one-time download token) |
| GET | `/ota/v1/download` | stream the AES-GCM ciphertext (one-time token; **no S3 URL**) |
| POST | `/ota/v1/confirm` | report apply result (drives adoption + auto-pause) |

**Admin** (header `x-ota-admin-token`, used by the [CLI](./cli.md)):

| Method | Path | Purpose |
|---|---|---|
| POST | `/admin/keys` | register a trusted Ed25519 **public** key |
| POST | `/admin/publish` | store a pre-signed release (manifest + ciphertext) |
| GET | `/admin/releases` | list releases + adoption/health |
| POST | `/admin/rollout` | set rollout % |
| POST | `/admin/pause` | pause / resume a release |
| POST | `/admin/rollback` | roll back a release |
| POST | `/admin/native-policy` | set the force-update gate per channel |

Plus `GET /health`.

### Request signing (client → backend)

Headers: `x-ota-install`, `x-ota-nonce`, `x-ota-timestamp`, `x-ota-signature`. The signature is
ECDSA-P256 over the canonical string `[METHOD, path, installId, nonce, timestamp, sha256(body)]`
joined by `\n`, made with the device's hardware private key. The backend verifies it against the
public key registered at `/enroll`. This is all handled for you by
[`react-native-dash-ota`](./react-native.md) on the client.

---

## Security model (what the backend guarantees)

- **It cannot forge updates** — it only stores/serves pre-signed manifests; the Ed25519 signing
  key never reaches it. A breached backend cannot push malicious code (native verifies the
  signature against a key embedded in the app binary).
- **Anti-replay** — per-request nonce + timestamp window; a server-issued nonce binds `/confirm`
  to a real `/check`.
- **No secret at enrollment** — devices register only their **public** key; there is no symmetric
  secret to intercept.
- **Server-side safety net** — auto-pause when a release's failure rate crosses the threshold.

See [POC.md](../POC.md) for the full threat model and design rationale.

---

## Production notes

- Put it behind your API gateway over **HTTPS**; the route core is framework-agnostic, so a
  Fastify/Koa adapter is a thin wrapper.
- Swap the disk store for **Postgres + Redis + object storage** via a custom `store`.
- Keep `requireRequestSignature` and `requireEnrollAuth` **on** in production.
