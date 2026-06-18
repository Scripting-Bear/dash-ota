/**
 * Connect/Express adapter. Exposes the OTA routes as a single standard
 * `(req, res, next)` middleware so you can mount the whole distributor inside an existing
 * Express (or any Connect-compatible) app — **without** this package depending on Express.
 *
 * Mount it at the **root** of your app (paths are absolute: `/ota/v1/*`, `/admin/*`,
 * `/health`); anything it doesn't own falls through to `next()`:
 *
 * ```ts
 * import express from 'express';
 * import { dashOtaMiddleware } from '@dash-ota/backend';
 *
 * const app = express();
 * app.use(dashOtaMiddleware({ adminToken: process.env.OTA_ADMIN_TOKEN, verifyEnrollToken }));
 * app.listen(4455);
 * ```
 *
 * The OTA request signature is computed over the **raw** body bytes, so this middleware must
 * see them. Mount it **before** any body parser, or — if a global `express.json()` runs first
 * — stash the bytes with the exported {@link rawBodySaver}:
 * `app.use(express.json({ verify: rawBodySaver }))`.
 *
 * @module express
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { URL } from 'node:url';
import { httpError, type Handler, type OtaRoute, type ReqCtx, writeNodeResult } from './http.js';
import { createOtaRoutes } from './routes.js';
import { type OtaBackendOptions, resolveBackendConfig } from './config.js';
import { Store } from './store.js';

/** A request that may already carry a captured raw/parsed body (Express/Connect). */
type AdapterReq = IncomingMessage & { rawBody?: Buffer; body?: unknown };
/** Connect-style `next` callback. */
type NextFn = (err?: unknown) => void;
/** The middleware signature accepted by Express, Connect, and friends. */
export type OtaMiddleware = (req: AdapterReq, res: ServerResponse, next: NextFn) => void;

/**
 * Body-parser `verify` callback that stashes the raw request bytes on `req.rawBody`. Use this
 * when a global JSON parser runs before the OTA middleware, so request-signature verification
 * still has the exact bytes the client signed:
 * `app.use(express.json({ verify: rawBodySaver }))`.
 */
export function rawBodySaver(req: AdapterReq, _res: ServerResponse, buf: Buffer): void {
  if (buf?.length) req.rawBody = buf;
}

/** Resolve the raw body: prefer an already-captured buffer, else drain the stream. */
function readRawBody(req: AdapterReq): Promise<Buffer> {
  if (Buffer.isBuffer(req.rawBody)) return Promise.resolve(req.rawBody);
  if (Buffer.isBuffer(req.body)) return Promise.resolve(req.body);
  // Stream not yet consumed by an upstream parser — drain it ourselves.
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Build a Connect middleware that dispatches a fixed route table; unmatched paths call next(). */
function middlewareFromRoutes(routes: readonly OtaRoute[]): OtaMiddleware {
  const table = new Map<string, Handler>();
  for (const r of routes) table.set(`${r.method} ${r.path}`, r.handler);

  return (req, res, next) => {
    const method = (req.method ?? 'GET').toUpperCase();
    const parsed = new URL(req.url ?? '/', 'http://localhost');
    const handler = table.get(`${method} ${parsed.pathname}`);
    if (!handler) {
      next();
      return;
    }
    readRawBody(req)
      .then((rawBody) => {
        const ctx: ReqCtx = {
          method,
          path: parsed.pathname,
          query: parsed.searchParams,
          headers: req.headers,
          rawBody,
          json<T>(): T {
            return JSON.parse(rawBody.toString('utf8') || 'null') as T;
          },
        };
        return handler(ctx);
      })
      .then((result) => writeNodeResult(res, result))
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : 'internal error';
        writeNodeResult(res, httpError(500, message, 'internal'));
      });
  };
}

/**
 * Create the OTA distributor as a single Connect/Express middleware.
 *
 * @param options partial config + hooks (auth, analytics, logger) + optional bring-your-own store
 * @returns a `(req, res, next)` middleware to `app.use(...)` at the root
 */
export function dashOtaMiddleware(options: OtaBackendOptions = {}): OtaMiddleware {
  const config = resolveBackendConfig(options);
  const store = options.store ?? new Store(config);
  return middlewareFromRoutes(createOtaRoutes(store, config));
}

/** @internal — reused by {@link createOtaBackend} to avoid rebuilding the route table. */
export { middlewareFromRoutes };
