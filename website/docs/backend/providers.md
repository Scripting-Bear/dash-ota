---
sidebar_position: 7
title: Storage & providers
---

# Storage providers & adapters

The backend stores everything through three providers. Use the defaults and you get a working
single server with nothing extra to run; swap any of them for the infrastructure you already have.

| Provider | Holds | Default | Built-in adapters |
|---|---|---|---|
| `DatabaseProvider` | releases, installs, trusted keys, native policies | disk JSON | **SQLite**, **Postgres** |
| `BlobStore` | the encrypted bundle bytes | disk files | **S3 / R2 / MinIO** |
| `CacheProvider` | request nonces, download tokens, rate-limit counters (all expiring) | in-memory | **Redis** |

## Three levels of effort

Every adapter works the same way, so you can start simple and scale when you need to:

1. **Default.** Disk plus in-memory. Nothing to install. Fine for a single server; set `storageDir`
   and `dataDir` to a backed-up location.
2. **One setting.** Set a URL or path (or the matching `OTA_*` variable) and the backend creates the
   adapter. The driver is an optional peer dependency, loaded on first use: a default install never
   pulls it in, and if you select one that isn't installed you get an `npm i <driver>` error.
   Supported majors: `pg` 8, `better-sqlite3` 11, `ioredis` 5, `@aws-sdk/client-s3` 3.
3. **Your own client.** Construct the provider yourself (Redis Cluster or Sentinel, a pooled
   Postgres connection, a configured S3 client) and pass it in `providers`.

```js
import { S3Client } from '@aws-sdk/client-s3';
import { Redis } from 'ioredis';
import pg from 'pg';
import { dashOtaMiddleware, PostgresDatabaseProvider, RedisCacheProvider, S3BlobStore } from '@dash-ota/backend';

const adminToken = process.env.OTA_ADMIN_TOKEN;

// 1. Default: disk + in-memory
dashOtaMiddleware({ adminToken, storageDir: '/var/lib/dash-ota/storage', dataDir: '/var/lib/dash-ota/data' });

// 2. One setting each; the drivers are loaded for you
dashOtaMiddleware({
  adminToken,
  databaseUrl: process.env.OTA_DATABASE_URL, // Postgres
  redisUrl: process.env.OTA_REDIS_URL,       // Redis
  s3Bucket: process.env.OTA_S3_BUCKET,       // S3, R2 or MinIO
});

// 3. Your own clients
dashOtaMiddleware({
  adminToken,
  providers: {
    db: new PostgresDatabaseProvider({ client: new pg.Pool({ connectionString: process.env.OTA_DATABASE_URL }) }),
    cache: new RedisCacheProvider({ client: new Redis(process.env.OTA_REDIS_URL) }),
    blob: new S3BlobStore({ bucket: 'ota-bundles', client: new S3Client({ region: 'us-east-1' }) }),
  },
});
```

`RedisCacheProvider` accepts an ioredis `Redis` or `Cluster` directly (backend 0.5.1 and later).

Precedence for the database: an explicit `providers.db` wins, else `databaseUrl` (Postgres), else
`sqlitePath` (SQLite), else the disk default.

## Why a shared cache matters

The `CacheProvider` holds request nonces (replay protection), download tokens, the nonces that
cover `/confirm` reports, and rate-limit counters. The in-memory default lives in one process, so
those checks only work on a single instance. Behind a load balancer, use Redis (or another shared
cache) so every instance sees the same state.

## Adapters

### SQLite: one file, no server

```ts
dashOtaMiddleware({ sqlitePath: './dash-ota.sqlite' }); // or OTA_SQLITE_PATH
```

Transactional, with no database server to run: a good fit for a single server that outgrows the
disk default. Optional peer: `npm i better-sqlite3` (native). The file and
schema are created on first use; WAL journal mode is enabled.

### Postgres: several instances

```ts
dashOtaMiddleware({ databaseUrl: 'postgres://user:pw@host:5432/db' }); // or OTA_DATABASE_URL
```

Optional peer: `npm i pg`. Records are stored as `jsonb` keyed by their natural id; writes are atomic
UPSERTs. The tables (`ota_releases`, `ota_installs`, `ota_trusted_keys`, `ota_retired_clients`,
`ota_native_policies`) are created on first use; there is no separate migration step. SQLite uses the
same five tables.

:::note[Concurrency caveat]
Per-row writes are atomic, but the adoption counters (`/confirm`) use a read-modify-write in the
Store, so a counter increment can be lost when many `/confirm` requests for the same release arrive
at once. This affects every `DatabaseProvider`, including the disk default.
:::

### Redis: shared cache

```ts
dashOtaMiddleware({ redisUrl: 'redis://localhost:6379' }); // or OTA_REDIS_URL
```

Optional peer: `npm i ioredis` (Redis 6.2 or later). Replay protection uses `SET NX PX`, and the rate
limiter is one Lua script (`INCR`, `PEXPIRE`, `PTTL`), so a crash can't leave a counter that never
expires. To share one Redis between apps, construct `RedisCacheProvider` yourself with a
`keyPrefix` (default `dashota:`); the `redisUrl` shortcut always uses the default prefix.

### S3, R2 or MinIO: object storage

```ts
dashOtaMiddleware({
  s3Bucket: 'ota-bundles',                 // OTA_S3_BUCKET
  s3Endpoint: 'https://<account>.r2.cloudflarestorage.com', // OTA_S3_ENDPOINT (R2/MinIO)
  s3ForcePathStyle: true,                  // OTA_S3_FORCE_PATH_STYLE (MinIO / some R2)
  s3Region: 'auto',                        // OTA_S3_REGION
  s3Prefix: 'bundles/',                    // OTA_S3_PREFIX
});
```

Optional peer: `npm i @aws-sdk/client-s3`. Credentials come from the standard AWS environment
variables and config chain. Downloads stream from the object; the backend never holds a whole file
in memory.

## How blobs are laid out

Files are stored by the SHA-256 of their contents at `blobs/<sha256>`, shared by all releases
rather than grouped per release. A file that appears in twenty releases is stored once. Every
download checks that the release being downloaded actually lists that file. There is no command to
delete a release, so stored files are never removed.

This is also why every release on a channel must use the same content key; see
[Keys, custody & rotation](/docs/security/key-management).

## Replacing the whole store

The three providers cover the infrastructure most people swap. If you need to replace the
persistence layer entirely, for example with a service that already owns this data, extend `Store`
and pass it in:

```js
import { createOtaBackend, Store } from '@dash-ota/backend';

class <YOUR_STORE> extends Store {
  // override the methods your persistence layer handles
}
const ota = createOtaBackend({ store: new <YOUR_STORE>(<YOUR_CONFIG>) });
```

A `Store` covers:

- Releases: `createRelease`, `missingBlobs`, `stageBlob`, `finalizeRelease`, `discardRelease`,
  `listReleases`, `getRelease`, `setRollout`, `setPaused`, `rollback`, and `pickEligible`, which does
  the targeting and rollout matching.
- Files: `statBlob`, `openBlobStream`.
- Installs: `enroll` (stores the device public key) and `getDevicePublicKey`.
- Trusted keys: `registerKey`, `getTrustedKey`.
- Replay protection and tokens: `registerNonce`, `rateLimit`, `issueDownloadToken` /
  `peekDownloadToken`, `issueServerNonce` / `consumeServerNonce`.
- Adoption: `recordConfirm`, which also triggers auto-pause.
- Native policy and old clients: `setNativePolicy`, `resolveNativePolicy`, `recordRetiredClient`,
  `getRetiredClients`, `retiredPolicy`.

`pickEligible` decides which release a device gets: exact `runtimeVersion`, the rollout bucket,
`bundleVersion` higher than the device's current one, matching channel and platform. Keep its rules
identical, or devices get releases they shouldn't. Replacing the three providers is almost always
the better option.

→ [Deployment](/docs/backend/deployment) · [Production hardening](/docs/backend/hardening)
```
