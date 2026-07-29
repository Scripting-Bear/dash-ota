---
sidebar_position: 5
title: Configuration
---

# Configuration

Every option is optional with a safe default, and each has an **env fallback** (handy for the
standalone server). Pass only what you need.

```ts
dashOtaMiddleware({
  adminToken: process.env.OTA_ADMIN_TOKEN,
  requireRequestSignature: true,
  requireEnrollAuth: true,
  // ...hooks (see Hooks page)
});
```

## Options & env

| Option | Env | Default | Meaning |
|---|---|---|---|
| `port` | `OTA_PORT` | `4455` | standalone listen port |
| `adminToken` | `OTA_ADMIN_TOKEN` | **`''` (empty ⇒ admin disabled)** | bearer for `/admin/*` (header `x-ota-admin-token`) |
| `storageDir` | `OTA_STORAGE_DIR` | `<pkg>/storage` | where encrypted bundles are stored (disk blob store) |
| `dataDir` | `OTA_DATA_DIR` | `<pkg>/.data` | release/install metadata (disk JSON store) |
| `timestampSkewMs` | `OTA_TS_SKEW_MS` | `300000` | allowed client clock skew |
| `downloadTokenTtlMs` | `OTA_DL_TTL_MS` | `120000` | one-time download token TTL |
| `nonceTtlMs` | `OTA_NONCE_TTL_MS` | `600000` | replay-nonce cache TTL |
| `maxBundleBytes` | `OTA_MAX_BUNDLE_BYTES` | `104857600` (100 MiB) | reject a ciphertext larger than this at `/admin/publish` |
| `enrollRateLimit` | `OTA_ENROLL_RATE` | `10` | max `/enroll` per install per window (`0` disables) |
| `checkRateLimit` | `OTA_CHECK_RATE` | `60` | max `/check` per authenticated install per window (`0` disables) |
| `rateLimitWindowMs` | `OTA_RATE_WINDOW_MS` | `60000` | fixed rate-limit window |
| `autoPauseFailureRate` | `OTA_AUTOPAUSE_RATE` | `0.2` | failure rate that auto-pauses a rollout |
| `autoPauseMinSamples` | `OTA_AUTOPAUSE_MIN` | `5` | min confirms before auto-pause can trip |
| `requireRequestSignature` | `OTA_REQUIRE_SIG` | `true` | enforce the device-key signature on `/check` + `/confirm` |
| `requireEnrollAuth` | `OTA_REQUIRE_ENROLL_AUTH` | `true` | require an enroll session token (see [`verifyEnrollToken`](/docs/backend/hooks)) |

### Storage selection

Pass a URL/path to swap the disk defaults for a real backend — see
[Storage providers & adapters](/docs/backend/providers) for the full model.

| Option | Env | Selects |
|---|---|---|
| `databaseUrl` | `OTA_DATABASE_URL` | Postgres `DatabaseProvider` (peer `pg`) |
| `sqlitePath` | `OTA_SQLITE_PATH` | SQLite `DatabaseProvider` (peer `better-sqlite3`) |
| `redisUrl` | `OTA_REDIS_URL` | Redis `CacheProvider` (peer `ioredis`) — **required for multi-instance** |
| `s3Bucket` (+ `s3Endpoint`, `s3Region`, `s3ForcePathStyle`, `s3Prefix`) | `OTA_S3_BUCKET`, … | S3/R2/MinIO `BlobStore` (peer `@aws-sdk/client-s3`) |

## Production posture

- **`adminToken` has no default** — leave it unset and `/admin/*` returns `503 admin_disabled`
  (fail-closed). Set a strong token, and serve `/admin/*` only over HTTPS.
- Keep `requireRequestSignature` and `requireEnrollAuth` **on**.
- Behind a load balancer, set `redisUrl` so anti-replay + rate limiting hold across replicas.
- Tune anti-replay windows, `maxBundleBytes`, and rate limits via env without code changes.

## `resolveBackendConfig`

`resolveBackendConfig(partial)` layers your options over the env/default config — it's what the
middleware/factory call internally. Useful if you want the resolved config object directly.

→ [Hooks](/docs/backend/hooks) · [Endpoints](/docs/backend/endpoints)
