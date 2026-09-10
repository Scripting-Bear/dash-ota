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
import { httpError, type OtaRoute, type ReqCtx, writeNodeResult } from './http.js';
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

/** Match a request path against a route pattern, capturing `:name` segments. */
function matchPath(pattern: string, pathname: string): Record<string, string> | null {
  const want = pattern.split('/');
  const got = pathname.split('/');
  if (want.length !== got.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < want.length; i += 1) {
    const seg = want[i] as string;
    const value = got[i] as string;
    if (seg.startsWith(':')) params[seg.slice(1)] = decodeURIComponent(value);
    else if (seg !== value) return null;
  }
  return params;
}

/** Build a Connect middleware that dispatches a fixed route table; unmatched paths call next(). */
function middlewareFromRoutes(routes: readonly OtaRoute[]): OtaMiddleware {
  return (req, res, next) => {
    const method = (req.method ?? 'GET').toUpperCase();
    const parsed = new URL(req.url ?? '/', 'http://localhost');

    let route: OtaRoute | undefined;
    let params: Record<string, string> = {};
    for (const r of routes) {
      if (r.method !== method) continue;
      const captured = matchPath(r.path, parsed.pathname);
      // Prefer a literal match over a parameterised one at the same shape.
      if (captured && (!route || Object.keys(captured).length < Object.keys(params).length)) {
        route = r;
        params = captured;
      }
    }
    if (!route) {
      next();
      return;
    }

    const fail = (err: unknown): void => {
      const message = err instanceof Error ? err.message : 'internal error';
      writeNodeResult(res, httpError(500, message, 'internal'));
    };
    const baseCtx = {
      method,
      path: parsed.pathname,
      query: parsed.searchParams,
      headers: req.headers,
      params,
    };

    // A streaming route needs the body unread. If a host's JSON parser already consumed it, the
    // upload cap can no longer be enforced as bytes arrive — so this route must be mounted before
    // any global parser (see the mounting note on `otaMiddleware`).
    if (route.streamBody) {
      const ctx: ReqCtx = {
        ...baseCtx,
        rawBody: Buffer.alloc(0),
        body: req,
        json<T>(): T {
          return null as T;
        },
      };
      Promise.resolve(route.handler(ctx))
        .then((result) => writeNodeResult(res, result))
        .catch(fail);
      return;
    }

    readRawBody(req)
      .then((rawBody) => {
        const ctx: ReqCtx = {
          ...baseCtx,
          rawBody,
          json<T>(): T {
            return JSON.parse(rawBody.toString('utf8') || 'null') as T;
          },
        };
        return route.handler(ctx);
      })
      .then((result) => writeNodeResult(res, result))
      .catch(fail);
  };
}

/**
 * Create the OTA distributor as a single Connect/Express middleware.
 *
 * Mount it at the **root** of your app, and **before any global body parser** — the OTA routes
 * are absolute (`/ota/v2/*`, `/admin/*`,
 * `/health`) and the device signs over the request `path`, so a sub-path mount breaks signature
 * verification.
 *
 * @param options partial config + hooks (auth, analytics, logger) + optional bring-your-own store
 * @returns a `(req, res, next)` middleware to `app.use(...)` at the root
 *
 * @example
 * ```ts
 * import express from 'express';
 * import { dashOtaMiddleware, rawBodySaver } from '@dash-ota/backend';
 *
 * const app = express();
 * // The signature is over the RAW body; keep the bytes if a parser runs first.
 * app.use(express.json({ verify: rawBodySaver }));
 * app.use(dashOtaMiddleware({
 *   adminToken: process.env.OTA_ADMIN_TOKEN,
 *   verifyEnrollToken: (token) => auth.verifySession(token),
 * }));
 * app.listen(4455);
 * ```
 */
export function dashOtaMiddleware(options: OtaBackendOptions = {}): OtaMiddleware {
  const config = resolveBackendConfig(options);
  const store = options.store ?? new Store(config, options.providers);
  return middlewareFromRoutes(createOtaRoutes(store, config));
}

/** @internal — reused by {@link createOtaBackend} to avoid rebuilding the route table. */
export { middlewareFromRoutes };
