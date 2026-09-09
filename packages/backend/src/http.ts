/**
 * A tiny dependency-free HTTP router over `node:http`. Deliberately minimal — keeping the
 * backend's dependency (and supply-chain) surface near zero is on-theme for a security
 * project, and this layer is trivially replaceable when the POC becomes a real microservice.
 *
 * @module http
 */

import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { pipeline, type Readable } from 'node:stream';
import { URL } from 'node:url';

/** Per-request context passed to handlers. */
export interface ReqCtx {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingHttpHeaders;
  rawBody: Buffer;
  /** Values captured from `:name` segments in the route path. */
  params: Record<string, string>;
  /**
   * The unread request body, when the route opted out of buffering (`streamBody`). Blob uploads
   * use this so a large body is spooled to disk instead of held in memory.
   */
  body?: Readable;
  /** parse the raw body as JSON (throws on invalid JSON). */
  json<T>(): T;
}

/** A JSON response. */
export interface JsonResult {
  kind?: 'json';
  status?: number;
  body: unknown;
  headers?: Record<string, string>;
}

/**
 * A binary response (used to serve the encrypted bundle). The body may be a fully-buffered
 * `Buffer` or a `Readable` stream — the download path uses a stream so it never holds the whole
 * ciphertext in memory. Set {@link contentLength} so the client receives a `Content-Length`
 * header (drives download progress + the native size pre-check).
 */
export interface BinaryResult {
  kind: 'binary';
  status?: number;
  contentType: string;
  body: Buffer | Readable;
  /** byte length of the body; emitted as `Content-Length` when set. */
  contentLength?: number;
  headers?: Record<string, string>;
}

export type HandlerResult = JsonResult | BinaryResult;
export type Handler = (ctx: ReqCtx) => Promise<HandlerResult> | HandlerResult;

/** A framework-agnostic route: method + exact path + handler. Consumed by every adapter. */
export interface OtaRoute {
  method: 'GET' | 'POST' | 'PUT';
  /** Exact path, or a pattern with `:name` segments, e.g. `/ota/v2/releases/:bundleId/blobs/:sha`. */
  path: string;
  handler: Handler;
  /**
   * Hand the handler the raw stream instead of buffering the body. Required for blob uploads: the
   * point of the cap is to stop reading past it, which is impossible once the body is buffered.
   */
  streamBody?: boolean;
}

/** Build a JSON response. */
export function json(body: unknown, status = 200, headers?: Record<string, string>): JsonResult {
  return { kind: 'json', status, body, headers };
}

/** Build a buffered binary response (whole body in memory). Prefer {@link binaryStream} for large payloads. */
export function binary(body: Buffer, contentType = 'application/octet-stream', status = 200): BinaryResult {
  return { kind: 'binary', status, contentType, body, contentLength: body.byteLength };
}

/** Build a streaming binary response with a known content length (the bundle is never buffered whole). */
export function binaryStream(
  body: Readable,
  contentLength: number,
  contentType = 'application/octet-stream',
  status = 200,
  headers?: Record<string, string>,
): BinaryResult {
  return { kind: 'binary', status, contentType, body, contentLength, ...(headers ? { headers } : {}) };
}

/**
 * Parse a single-range `Range` header against a known object size.
 *
 * Only the single-range forms are honoured. A multi-range request would need a multipart body,
 * which no OTA client sends and which is easy to get subtly wrong, so it is treated as no range
 * and the whole blob is returned — always correct, just not optimal.
 *
 * @param value - the raw header, if present.
 * @param size - total size of the object.
 * @returns the inclusive range, `null` for "send it all", or `'unsatisfiable'` for a 416.
 */
export function parseRange(value: string | undefined, size: number): { start: number; end: number } | null | 'unsatisfiable' {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match) return null;
  const [, rawStart, rawEnd] = match;
  if (rawStart === '' && rawEnd === '') return null;

  // "bytes=-N" asks for the final N bytes.
  if (rawStart === '') {
    const suffix = Number(rawEnd);
    if (!Number.isFinite(suffix) || suffix <= 0) return 'unsatisfiable';
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(rawStart);
  if (!Number.isFinite(start) || start >= size) return 'unsatisfiable';
  const end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1);
  if (!Number.isFinite(end) || end < start) return 'unsatisfiable';
  return { start, end };
}

/** Build a JSON error response. */
export function httpError(status: number, error: string, code?: string): JsonResult {
  return { kind: 'json', status, body: { error, code } };
}

/** Write a {@link HandlerResult} to a `node:http` (or Express) `ServerResponse`. */
export function writeNodeResult(res: import('node:http').ServerResponse, result: HandlerResult): void {
  const status = result.status ?? 200;
  if (result.kind === 'binary') {
    const headers: Record<string, string> = { 'content-type': result.contentType, ...(result.headers ?? {}) };
    if (result.contentLength !== undefined) headers['content-length'] = String(result.contentLength);
    res.writeHead(status, headers);
    if (Buffer.isBuffer(result.body)) {
      res.end(result.body);
    } else {
      // Streaming body: `pipeline` destroys BOTH ends on any error or a client abort — so the
      // file descriptor is always released (no leak under aborted downloads). The status/headers
      // are already sent, so on a mid-transfer error we can only tear the socket down.
      pipeline(result.body, res, () => {});
    }
    return;
  }
  res.writeHead(status, { 'content-type': 'application/json', ...(result.headers ?? {}) });
  res.end(JSON.stringify(result.body));
}

/** One registered route, with its path compiled to a matcher. */
interface CompiledRoute {
  method: string;
  segments: string[];
  handler: Handler;
  streamBody: boolean;
}

/** A minimal router supporting exact paths and `:name` parameters. */
export class Router {
  private readonly routes: CompiledRoute[] = [];

  /** Register a handler for `METHOD path`. */
  on(method: string, path: string, handler: Handler, streamBody = false): this {
    this.routes.push({ method: method.toUpperCase(), segments: path.split('/'), handler, streamBody });
    return this;
  }

  get(path: string, handler: Handler): this {
    return this.on('GET', path, handler);
  }

  post(path: string, handler: Handler): this {
    return this.on('POST', path, handler);
  }

  put(path: string, handler: Handler, streamBody = false): this {
    return this.on('PUT', path, handler, streamBody);
  }

  /** Register a batch of framework-agnostic routes. */
  register(routes: readonly OtaRoute[]): this {
    for (const r of routes) this.on(r.method, r.path, r.handler, r.streamBody ?? false);
    return this;
  }

  /**
   * Find the route for a path, capturing any `:name` segments.
   *
   * Exact segments are preferred over parameters at the same position, so a literal route can
   * coexist with a parameterised one.
   */
  private match(method: string, pathname: string): { route: CompiledRoute; params: Record<string, string> } | null {
    const parts = pathname.split('/');
    let best: { route: CompiledRoute; params: Record<string, string>; exactness: number } | null = null;
    for (const route of this.routes) {
      if (route.method !== method || route.segments.length !== parts.length) continue;
      const params: Record<string, string> = {};
      let exactness = 0;
      let ok = true;
      for (let i = 0; i < route.segments.length; i += 1) {
        const seg = route.segments[i] as string;
        const got = parts[i] as string;
        if (seg.startsWith(':')) params[seg.slice(1)] = decodeURIComponent(got);
        else if (seg === got) exactness += 1;
        else {
          ok = false;
          break;
        }
      }
      if (ok && (!best || exactness > best.exactness)) best = { route, params, exactness };
    }
    return best ? { route: best.route, params: best.params } : null;
  }

  /** Start an HTTP server bound to `port`. Resolves once listening. */
  listen(port: number): Promise<Server> {
    const server = createServer((req, res) => {
      const method = req.method ?? 'GET';
      const url = req.url ?? '/';
      const fail = (err: unknown): void => {
        const message = err instanceof Error ? err.message : 'internal error';
        this.write(res, httpError(500, message, 'internal'));
      };

      // A streaming route must receive the body unread, so the handler can enforce its cap as the
      // bytes arrive rather than after they are all in memory.
      const matched = this.match(method.toUpperCase(), new URL(url, 'http://localhost').pathname);
      if (matched?.route.streamBody) {
        void this.dispatch(method, url, req.headers, Buffer.alloc(0), req)
          .then((result) => this.write(res, result))
          .catch(fail);
        return;
      }

      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        void this.dispatch(method, url, req.headers, Buffer.concat(chunks))
          .then((result) => this.write(res, result))
          .catch(fail);
      });
      req.on('error', () => this.write(res, httpError(400, 'bad request')));
    });
    return new Promise((resolve) => server.listen(port, () => resolve(server)));
  }

  /** Resolve a route and run it (also reachable directly from tests). */
  async dispatch(
    method: string,
    url: string,
    headers: IncomingHttpHeaders,
    rawBody: Buffer,
    body?: Readable,
  ): Promise<HandlerResult> {
    const parsed = new URL(url, 'http://localhost');
    const matched = this.match(method.toUpperCase(), parsed.pathname);
    if (!matched) return httpError(404, `no route for ${method} ${parsed.pathname}`, 'not_found');
    const ctx: ReqCtx = {
      method: method.toUpperCase(),
      path: parsed.pathname,
      query: parsed.searchParams,
      headers,
      rawBody,
      params: matched.params,
      ...(body ? { body } : {}),
      json<T>(): T {
        return JSON.parse(rawBody.toString('utf8') || 'null') as T;
      },
    };
    return matched.route.handler(ctx);
  }

  private write(res: import('node:http').ServerResponse, result: HandlerResult): void {
    writeNodeResult(res, result);
  }
}
