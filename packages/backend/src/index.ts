/**
 * `@dash-ota/backend` — the OTA distributor as a config-driven, plug-and-play library.
 *
 * Three ways to use it, all sharing one route core:
 *
 * 1. **Embed in Express/Connect** (recommended for real deployments):
 *    ```ts
 *    app.use(dashOtaMiddleware({ adminToken, verifyEnrollToken, onConfirm }));
 *    ```
 * 2. **Umbrella factory** — own the store/config and get every adapter from one object:
 *    ```ts
 *    const ota = createOtaBackend({ adminToken, logger });
 *    app.use(ota.middleware);            // Express/Connect
 *    await ota.listen(4455);             // or standalone node:http
 *    ```
 * 3. **Standalone server** — `npm run backend` boots {@link createRouter} on `node:http`.
 *
 * The backend never signs and never holds a private key; it serves **pre-signed** manifests
 * + AES-GCM ciphertext and enforces targeting/rollout/anti-replay.
 *
 * @module @dash-ota/backend
 */

import { type OtaBackendOptions, resolveBackendConfig } from './config.js';
import { type OtaMiddleware, middlewareFromRoutes } from './express.js';
import { Router } from './http.js';
import { createOtaRoutes } from './routes.js';
import { Store } from './store.js';
import type { Server } from 'node:http';
import type { BackendConfig } from './config.js';
import type { OtaRoute } from './http.js';

export * from './config.js';
export { createOtaRoutes } from './routes.js';
export { createRouter } from './server.js';
export { Router, json, binary, httpError, writeNodeResult } from './http.js';
export type { OtaRoute, ReqCtx, HandlerResult, JsonResult, BinaryResult, Handler } from './http.js';
export { dashOtaMiddleware, rawBodySaver } from './express.js';
export type { OtaMiddleware } from './express.js';
export {
  Store,
  type ReleaseRecord,
  type AdoptionStats,
} from './store.js';

/** Everything you need to serve OTA, assembled once from a single config. */
export interface OtaBackend {
  /** the fully-resolved configuration. */
  config: BackendConfig;
  /** the persistence + lookup layer (disk-backed by default). */
  store: Store;
  /** the framework-agnostic route table. */
  routes: OtaRoute[];
  /** a Connect/Express middleware — `app.use(ota.middleware)` at the root. */
  middleware: OtaMiddleware;
  /** start a standalone `node:http` server (resolves once listening). */
  listen(port?: number): Promise<Server>;
}

/**
 * Assemble the OTA backend once and expose every adapter (Express middleware + standalone
 * server) over a single store/config — so the route table and store aren't rebuilt per call.
 *
 * @param options partial config + hooks (auth, analytics, logger) + optional bring-your-own store
 * @returns an {@link OtaBackend} with `.middleware`, `.listen()`, `.routes`, `.store`, `.config`
 *
 * @example Mount into an existing Express app
 * ```ts
 * import express from 'express';
 * import { createOtaBackend, rawBodySaver } from '@dash-ota/backend';
 *
 * const ota = createOtaBackend({
 *   adminToken: process.env.OTA_ADMIN_TOKEN,
 *   verifyEnrollToken: (token) => auth.verifySession(token),
 *   onConfirm: (e) => metrics.track('ota_confirm', e),
 * });
 *
 * const app = express();
 * app.use(express.json({ verify: rawBodySaver })); // keep raw bytes for the request signature
 * app.use(ota.middleware);                          // mount at the ROOT
 * app.listen(4455);
 * ```
 *
 * @example Run standalone (no Express)
 * ```ts
 * const ota = createOtaBackend({ adminToken: process.env.OTA_ADMIN_TOKEN });
 * await ota.listen(4455); // node:http server
 * ```
 */
export function createOtaBackend(options: OtaBackendOptions = {}): OtaBackend {
  const config = resolveBackendConfig(options);
  const store = options.store ?? new Store(config);
  const routes = createOtaRoutes(store, config);
  return {
    config,
    store,
    routes,
    middleware: middlewareFromRoutes(routes),
    listen(port = config.port): Promise<Server> {
      return new Router().register(routes).listen(port);
    },
  };
}
