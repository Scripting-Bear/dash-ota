---
sidebar_position: 5
title: Configuration
---

# Configuration

Every option can be passed to `dashOtaMiddleware()` / `createOtaBackend()` or set through an
environment variable. Options you pass win over the environment; an option passed as `undefined`
counts as not passed. Pass only what you need.

```js
dashOtaMiddleware({
  adminToken: process.env.OTA_ADMIN_TOKEN,
  storageDir: '/var/lib/dash-ota/storage',
  dataDir: '/var/lib/dash-ota/data',
  verifyEnrollToken: async (token) => <YOUR_SESSION_CHECK>(token),
});
```

## Options and environment variables

| Option | Env | Default | Meaning |
|---|---|---|---|
| `port` | `OTA_PORT` | `4455` | listen port of the standalone server |
| `adminToken` | `OTA_ADMIN_TOKEN` | empty: admin routes disabled | token for `/admin/*`, sent in the `x-ota-admin-token` header |
| `storageDir` | `OTA_STORAGE_DIR` | `<cwd>/.dash-ota/storage` | release files, with the disk store |
| `dataDir` | `OTA_DATA_DIR` | `<cwd>/.dash-ota/data` | release and device metadata, with the disk store |
| `timestampSkewMs` | `OTA_TS_SKEW_MS` | `300000` (5 min) | allowed clock difference on signed requests |
| `nonceTtlMs` | `OTA_NONCE_TTL_MS` | `600000` (10 min) | how long a request nonce is remembered; keep it at least twice `timestampSkewMs` |
| `downloadTokenTtlMs` | `OTA_DL_TTL_MS` | `1800000` (30 min) | lifetime of a download token; reusable for every file of that release until then |
| `maxBundleBytes` | `OTA_MAX_BUNDLE_BYTES` | `104857600` (100 MiB) | cap on a whole release |
| `maxBlobBytes` | `OTA_MAX_BLOB_BYTES` | `67108864` (64 MiB) | cap on one uploaded file, enforced while it arrives |
| `maxAdminBodyBytes` | `OTA_MAX_ADMIN_BODY_BYTES` | `33554432` (32 MiB) | cap on an admin JSON body, such as a release manifest |
| `enrollRateLimit` | `OTA_ENROLL_RATE` | `10` | `/enroll` requests per install per window; `0` turns it off |
| `checkRateLimit` | `OTA_CHECK_RATE` | `60` | `/check` requests per install per window; `0` turns it off |
| `rateLimitWindowMs` | `OTA_RATE_WINDOW_MS` | `60000` | rate-limit window |
| `autoPauseFailureRate` | `OTA_AUTOPAUSE_RATE` | `0.2` | share of failure reports that pauses a release |
| `autoPauseMinSamples` | `OTA_AUTOPAUSE_MIN` | `5` | reports needed before auto-pause can trigger |
| `requireRequestSignature` | `OTA_REQUIRE_SIG` | `true` | require the device-key signature on `/check` and `/confirm` |
| `requireEnrollAuth` | `OTA_REQUIRE_ENROLL_AUTH` | `true` | require an enroll token (checked by `verifyEnrollToken` if you set it, otherwise only for presence) |

Other limits are fixed: device and unauthenticated JSON bodies are capped at 64 KiB, and larger
bodies get `413 too_large`.

The standalone server also reads `OTA_ACCESS_LOG=true`, which logs every request's status, method
and path.

### Storage

Set one of these to replace the disk defaults. See [Storage providers](/docs/backend/providers).

| Option | Env | Selects |
|---|---|---|
| `databaseUrl` | `OTA_DATABASE_URL` | Postgres database (optional peer `pg`) |
| `sqlitePath` | `OTA_SQLITE_PATH` | SQLite database (optional peer `better-sqlite3`) |
| `redisUrl` | `OTA_REDIS_URL` | Redis cache (optional peer `ioredis`); needed with more than one instance |
| `s3Bucket`, `s3Region`, `s3Endpoint`, `s3ForcePathStyle`, `s3Prefix` | `OTA_S3_BUCKET`, `OTA_S3_REGION`, `OTA_S3_ENDPOINT`, `OTA_S3_FORCE_PATH_STYLE=true`, `OTA_S3_PREFIX` | S3, R2 or MinIO file storage (optional peer `@aws-sdk/client-s3`) |

### Hooks

`verifyEnrollToken`, `onConfirm`, `onPublish` and `logger` are options too. See
[Hooks](/docs/backend/hooks).

## Production checklist

- Set a long random `adminToken`, and reach `/admin/*` only over HTTPS. With no token the admin
  routes answer `503 admin_disabled`.
- Set `verifyEnrollToken` to check a real user session.
- Leave `requireRequestSignature` and `requireEnrollAuth` on. They exist to be turned off in tests.
- Set `storageDir` and `dataDir` to a backed-up location, or use a database and object storage.
- With more than one instance, set `redisUrl` so replay protection and rate limits are shared.

## `resolveBackendConfig`

`resolveBackendConfig(options)` returns the complete configuration: your options over the
environment over the defaults. The middleware and the factory call it; use it if you need the
resolved values yourself.

→ [Hooks](/docs/backend/hooks) · [Endpoints](/docs/backend/endpoints)
