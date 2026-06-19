---
sidebar_position: 2
title: '@dash-ota/backend'
---

# API — `@dash-ota/backend`

## Functions

### `dashOtaMiddleware(options?)`
```ts
function dashOtaMiddleware(options?: OtaBackendOptions): OtaMiddleware
```
A Connect/Express `(req, res, next)` middleware. Mount at the root. → [Express](/docs/backend/express)

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
Umbrella factory — build the store/config once, get every adapter. → [Umbrella](/docs/backend/umbrella)

### `rawBodySaver(req, res, buf)`
A body-parser `verify` callback that stashes raw bytes on `req.rawBody` (needed for request-signature
verification when a JSON parser runs first).

### `createRouter(store, config)`
Builds the standalone `node:http` `Router`. Used by the bundled server.

## Types

### `OtaBackendOptions` (= `Partial<BackendConfig>` + `store?`)
```ts
interface BackendConfig {
  port; adminToken; storageDir; dataDir;
  timestampSkewMs; downloadTokenTtlMs; nonceTtlMs;
  autoPauseFailureRate; autoPauseMinSamples;
  requireRequestSignature; requireEnrollAuth;
  // hooks:
  logger?; verifyEnrollToken?; onConfirm?; onPublish?;
}
```
→ [Configuration](/docs/backend/configuration) · [Hooks](/docs/backend/hooks)

### Hook signatures
```ts
verifyEnrollToken?: (token: string | undefined, principal: EnrollPrincipal) => boolean | Promise<boolean>;
onConfirm?: (event: ConfirmEvent) => void;   // { installId, bundleId, status, reason?, autoPaused }
onPublish?: (event: PublishEvent) => void;   // { bundleId, platform, channel, bundleVersion, runtimeVersion, rolloutPercentage }
```

### Other exports
- `Store`, `ReleaseRecord`, `AdoptionStats`.
- `Router`, `json`, `binary`, `httpError`, `writeNodeResult`.
- `OtaRoute`, `ReqCtx`, `HandlerResult`, `OtaMiddleware`.
- `resolveBackendConfig`, `loadConfig`.

→ [Endpoints reference](/docs/backend/endpoints)
