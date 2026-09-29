/**
 * Connect/Express adapter. Exposes the OTA routes as a single standard
 * `(req, res, next)` middleware so you can mount the whole distributor inside an existing
 * Express (or any Connect-compatible) app — **without** this package depending on Express.
 *
 * Mount it at the **root** of your app (paths are absolute: `/ota/v2/*`, `/admin/*`,
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
import {
  answerUnread,
  bodyLimit,
  errorResult,
  httpError,
  matchRoute,
  type OtaRoute,
  parseJsonBody,
  parseRequestUrl,
  payloadTooLarge,
  readBody,
  type ReqCtx,
  writeNodeResult,
} from './http.js';
import { createOtaRoutes } from './routes.js';
import { type OtaBackendOptions, resolveBackendConfig } from './config.js';
import { Store } from './store.js';

/** A request that may already carry a captured raw/parsed body (Express/Connect). */
type AdapterReq = IncomingMessage & { rawBody?: Buffer; body?: unknown; ip?: string };
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

/**
 * The body an upstream parser already consumed, or undefined while the stream is still unread.
 *
 * Without `rawBodySaver` (or for an empty body, which it skips) the bytes are gone and the stream
 * will never emit `end` again, so the parsed value is re-serialised instead of waited for.
 */
function consumedBody(req: AdapterReq): Buffer | undefined {
  if (Buffer.isBuffer(req.rawBody)) return req.rawBody;
  if (Buffer.isBuffer(req.body)) return req.body;
  if (!req.readableEnded) return undefined;
  if (typeof req.body === 'string') return Buffer.from(req.body, 'utf8');
  if (req.body === undefined || req.headers['content-length'] === '0') return Buffer.alloc(0);
  return Buffer.from(JSON.stringify(req.body), 'utf8');
}

/** Resolve the raw body under `limit`: an already-consumed one, else read the stream. Null when over the limit. */
async function readRawBody(req: AdapterReq, limit: number): Promise<Buffer | null> {
  const consumed = consumedBody(req);
  if (consumed) return consumed.length > limit ? null : consumed;
  return readBody(req, limit);
}

/** Build a Connect middleware that dispatches a fixed route table; unmatched paths call next(). */
function middlewareFromRoutes(routes: readonly OtaRoute[]): OtaMiddleware {
  return (req, res, next) => {
    const method = (req.method ?? 'GET').toUpperCase();
    const parsed = parseRequestUrl(req.url);
    const matched = parsed ? matchRoute(routes, method, parsed.pathname) : null;
    if (matched === 'malformed') {
      answerUnread(req, res, httpError(400, 'malformed request path', 'bad_request'));
      return;
    }
    if (!parsed || !matched) {
      next();
      return;
    }
    const { route, params } = matched;

    const fail = (err: unknown): void => writeNodeResult(res, errorResult(err));
    const remoteAddress = req.ip ?? req.socket?.remoteAddress;
    const baseCtx = {
      method,
      path: parsed.pathname,
      query: parsed.searchParams,
      headers: req.headers,
      params,
      ...(remoteAddress ? { remoteAddress } : {}),
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

    const limit = bodyLimit(route, req.headers);
    readRawBody(req, limit)
      .then((rawBody) => {
        if (!rawBody) return payloadTooLarge(`request body exceeds ${limit} bytes`);
        const ctx: ReqCtx = {
          ...baseCtx,
          rawBody,
          json<T>(): T {
            return parseJsonBody<T>(rawBody);
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
