---
sidebar_position: 2
title: '@dash-ota/backend'
---

# `@dash-ota/backend`

## Functions

### `dashOtaMiddleware(options?)`
```ts
function dashOtaMiddleware(options?: OtaBackendOptions): OtaMiddleware
```
A Connect/Express `(req, res, next)` middleware. Mount it at the root. See [Express](/docs/backend/express).

### `createOtaBackend(options?)`
```ts
function createOtaBackend(options?: OtaBackendOptions): {
  config: BackendConfig;
  store: Store;
  routes: OtaRoute[];
  middleware: OtaMiddleware;
  listen(port?: number): Promise<Server>;
}
```
Builds the configuration and store once and returns every way to serve them. See [Factory](/docs/backend/umbrella).

### `rawBodySaver(req, res, buf)`
A body-parser `verify` callback that keeps the raw bytes on `req.rawBody`. Request signatures are
checked against those bytes, so you need it whenever a JSON parser runs before the middleware.

### `createRouter(store, config)`
Builds the standalone `node:http` `Router`, with the request log turned on when `OTA_ACCESS_LOG=true`.
The bundled server (`dist/server.js`) uses it.

### `createOtaRoutes(store, config)`
The route table on its own, for wiring into a framework the middleware doesn't fit.

## Types

### `OtaBackendOptions`
`Partial<BackendConfig>` plus `store?` (a complete `Store`) and `providers?` (`{ db?, blob?, cache? }`).

```ts
interface BackendConfig {
  port: number; adminToken: string; storageDir: string; dataDir: string;
  timestampSkewMs: number; downloadTokenTtlMs: number; nonceTtlMs: number;
  autoPauseFailureRate: number; autoPauseMinSamples: number;
  maxBundleBytes: number; maxBlobBytes: number; maxAdminBodyBytes?: number;
  enrollRateLimit: number; checkRateLimit: number; rateLimitWindowMs: number;
  requireRequestSignature: boolean; requireEnrollAuth: boolean;
  redisUrl?: string; databaseUrl?: string; sqlitePath?: string;
  s3Bucket?: string; s3Region?: string; s3Endpoint?: string; s3ForcePathStyle?: boolean; s3Prefix?: string;
  // hooks
  logger?: OtaBackendLogger;
  verifyEnrollToken?: (token: string | undefined, principal: EnrollPrincipal) => boolean | Promise<boolean>;
  onConfirm?: (event: ConfirmEvent) => void;
  onPublish?: (event: PublishEvent) => void;
}
```

Defaults and environment variables for each field: [Configuration](/docs/backend/configuration).
### Hook signatures
```ts
verifyEnrollToken?: (token: string | undefined, principal: EnrollPrincipal) => boolean | Promise<boolean>;
onConfirm?: (event: ConfirmEvent) => void;   // { installId, bundleId, status, reason?, autoPaused }
onPublish?: (event: PublishEvent) => void;   // { bundleId, platform, channel, bundleVersion, runtimeVersion, rolloutPercentage }
```

See [Hooks](/docs/backend/hooks).

### Other exports
- Storage: `Store`, `DiskDatabaseProvider`, `DiskBlobStore`, `MemoryCacheProvider`,
  `PostgresDatabaseProvider`, `SqliteDatabaseProvider`, `RedisCacheProvider`, `S3BlobStore`, and the
  types `DatabaseProvider`, `BlobStore`, `CacheProvider`, `StoreProviders`, `ReleaseRecord`,
  `InstallRecord`, `AdoptionStats`, `RateLimitResult`, plus each adapter's options and client type
  (`RedisLike`, `PgLike`, `S3Like`, `SqliteLike`).
- HTTP: `Router`, `json`, `binary`, `binaryStream`, `httpError`, `writeNodeResult`, and the types
  `OtaRoute`, `ReqCtx`, `HandlerResult`, `JsonResult`, `BinaryResult`, `Handler`, `OtaMiddleware`.
- Configuration: `resolveBackendConfig`, `loadConfig`, and the types in `config.ts`.

→ [Endpoints reference](/docs/backend/endpoints)
