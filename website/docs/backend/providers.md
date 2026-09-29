---
sidebar_position: 7
title: Storage & providers
---

# Storage providers & adapters

The backend keeps **no storage logic of its own**. It composes three pluggable providers, so you
bring the infrastructure you already run — or nothing at all and get a working single node.

| Provider | Holds | Default | Built-in adapters |
|---|---|---|---|
| `DatabaseProvider` | releases, installs, trusted keys, native policies | disk JSON | **SQLite**, **Postgres** |
| `BlobStore` | the encrypted bundle bytes | disk files | **S3 / R2 / MinIO** |
| `CacheProvider` | nonces, one-time tokens, rate-limit counters (TTL'd) | in-memory | **Redis** |

## Three levels of effort

Every adapter follows the same model, so you can start trivially and scale when you actually need to:

1. **Beginner (default, zero config).** `dashOtaMiddleware()` → disk + in-memory. Nothing to install,
   works immediately. Fine for a single node.
2. **Upgrade (one line).** Set a URL/path (or the matching `OTA_*` env) and the backend wires the
   adapter for you. The driver is an **optional peer dependency**, loaded lazily on first use — a
   default install never pulls it in, and if it's selected but missing you get a clear
   `npm i <driver>` error.
3. **Advanced (full control).** Construct the provider yourself (custom client, Cluster/Sentinel,
   pooled connections, read replicas) and inject it via `providers`.

```ts
// 1. Beginner — disk + in-memory
dashOtaMiddleware();

// 2. Upgrade — one line each (drivers auto-loaded)
dashOtaMiddleware({
  databaseUrl: process.env.OTA_DATABASE_URL, // Postgres
  redisUrl: process.env.OTA_REDIS_URL,       // Redis
  s3Bucket: process.env.OTA_S3_BUCKET,       // S3/R2/MinIO
});

// 3. Advanced — inject your own
import { RedisCacheProvider, PostgresDatabaseProvider, S3BlobStore } from '@dash-ota/backend';
dashOtaMiddleware({
  providers: {
    db: new PostgresDatabaseProvider({ client: myPgPool }),
    cache: new RedisCacheProvider({ client: myRedisCluster }),
    blob: new S3BlobStore({ bucket: 'ota', client: myS3Client }),
  },
});
```

Precedence for the database: an explicit `providers.db` wins, else `databaseUrl` (Postgres), else
`sqlitePath` (SQLite), else the disk default.

## Why a shared cache matters

The `CacheProvider` guards **anti-replay** (client nonces), **one-time download tokens**, **server
nonces**, and **rate limiting**. The in-memory default is per-process, so those guarantees only hold
on a single instance. **Behind a load balancer you must use Redis** (or another shared cache) — the
counters and replay guard need to be shared across replicas.

## Adapters

### SQLite — durable, single file, no server

```ts
dashOtaMiddleware({ sqlitePath: './dash-ota.sqlite' }); // or OTA_SQLITE_PATH
```

ACID and concurrency-safe, with nothing to run — the sweet spot between the disk default and a full
Postgres deployment for a single node. Optional peer: `npm i better-sqlite3` (native). The file and
schema are created on first use; WAL journal mode is enabled.

### Postgres — durable, scale-out

```ts
dashOtaMiddleware({ databaseUrl: 'postgres://user:pw@host:5432/db' }); // or OTA_DATABASE_URL
```

Optional peer: `npm i pg`. Records are stored as `jsonb` keyed by their natural id; writes are atomic
UPSERTs. The schema (`ota_releases`, `ota_installs`, `ota_trusted_keys`, `ota_native_policies`) is
created on first use — no separate migration step.

:::note[Concurrency caveat]
Per-row writes are atomic, but the adoption counters (`/confirm`) use a read-modify-write in the
Store, so a counter increment can be lost under very high concurrent `/confirm`. Optimistic-locking
that path is a tracked follow-up; it affects every `DatabaseProvider`, including the disk default.
:::

### Redis — multi-instance cache

```ts
dashOtaMiddleware({ redisUrl: 'redis://localhost:6379' }); // or OTA_REDIS_URL
```

Optional peer: `npm i ioredis` (requires Redis 6.2+ for `GETDEL`). Anti-replay uses `SET NX PX`,
one-time tokens use atomic `GETDEL`, and the rate limiter is a single Lua `INCR`+`PEXPIRE`+`PTTL`
(no orphaned-key race). Namespace a shared Redis with `keyPrefix` (default `dashota:`).

### S3 / R2 / MinIO — object storage

```ts
dashOtaMiddleware({
  s3Bucket: 'ota-bundles',                 // OTA_S3_BUCKET
  s3Endpoint: 'https://<account>.r2.cloudflarestorage.com', // OTA_S3_ENDPOINT (R2/MinIO)
  s3ForcePathStyle: true,                  // OTA_S3_FORCE_PATH_STYLE (MinIO / some R2)
  s3Region: 'auto',                        // OTA_S3_REGION
  s3Prefix: 'bundles/',                    // OTA_S3_PREFIX
});
```

Optional peer: `npm i @aws-sdk/client-s3`. Credentials come from the standard AWS env chain. The
download path **streams** straight from the object (the backend never buffers a whole ciphertext).

## How blobs are laid out

Worth knowing before you point this at a bucket: blobs are **content-addressed and global**, stored
at `blobs/<sha256>`, not grouped per release. One file that appears in twenty releases is stored
once. Deleting a release only removes the blobs no other release still references, and every read
re-checks that the requesting release's manifest actually lists that blob.

This is why the content key must stay stable for a channel — see
[Keys, custody & rotation](/docs/security/key-management).

## Replacing the whole store

The three providers cover the infrastructure most people swap. If you need to replace the
persistence layer wholesale — a different database shape, an existing service that already owns
this data — implement `Store` itself and pass it in:

```ts
import { createOtaBackend } from '@dash-ota/backend';
const ota = createOtaBackend({ store: new MyStore(config) });
```

A `Store` owns six groups of behaviour:

- **Releases** — `addRelease`, `listReleases`, `getRelease`, `setRollout`, `setPaused`, `rollback`,
  and `pickEligible`, which does the targeting and rollout matching.
- **Installs** — `enroll` (stores the device public key, idempotent so key rotation works) and
  `getDevicePublicKey`.
- **Trusted keys** — `registerKey`, `getTrustedKey`, used to sanity-check publishes.
- **Anti-replay** — `registerNonce`, `issueDownloadToken` / `peekDownloadToken`,
  `issueServerNonce` / `consumeServerNonce`.
- **Adoption** — `recordConfirm`, which also trips auto-pause past the failure threshold.
- **Native policy** — `setNativePolicy`, `resolveNativePolicy`.

Keep `pickEligible`'s semantics identical — exact `runtimeVersion`, the stable rollout bucket,
`bundleVersion` greater than the device's current, matching channel and platform. Targeting
correctness lives entirely in that method.

→ [Deployment](/docs/backend/deployment) · [Production hardening](/docs/backend/hardening)
```
