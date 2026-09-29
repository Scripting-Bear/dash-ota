/**
 * A tiny dependency-free HTTP router over `node:http`. Deliberately minimal — keeping the
 * backend's dependency (and supply-chain) surface near zero is on-theme for a security
 * project, and this layer is trivially replaceable if you would rather route through your own framework.
 *
 * @module http
 */

import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { pipeline, type Readable } from 'node:stream';
import { URL } from 'node:url';

/** Body cap for a route that declares none. Sized for device requests, which are a few hundred bytes. */
export const DEFAULT_MAX_BODY_BYTES = 64 * 1024;

/** A client error a handler can throw; every adapter answers it with its status instead of a 500. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

/** Per-request context passed to handlers. */
export interface ReqCtx {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingHttpHeaders;
  rawBody: Buffer;
  /** Values captured from `:name` segments in the route path. */
  params: Record<string, string>;
  /** Peer address as the adapter sees it: the proxy's address unless the host resolves forwarding. */
  remoteAddress?: string;
  /**
   * The unread request body, when the route opted out of buffering (`streamBody`). Blob uploads
   * use this so a large body is spooled to disk instead of held in memory.
   */
  body?: Readable;
  /** parse the raw body as JSON; an empty body is `null`, invalid JSON throws a 400 {@link HttpError}. */
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
  method: 'GET' | 'HEAD' | 'POST' | 'PUT';
  /** Exact path, or a pattern with `:name` segments, e.g. `/ota/v2/releases/:bundleId/blobs/:sha`. */
  path: string;
  handler: Handler;
  /**
   * Hand the handler the raw stream instead of buffering the body. Required for blob uploads: the
   * point of the cap is to stop reading past it, which is impossible once the body is buffered.
   */
  streamBody?: boolean;
  /**
   * Largest body buffered for this route; a larger one is read to the end, discarded and answered
   * 413. Defaults to {@link DEFAULT_MAX_BODY_BYTES}. A function sees the headers, so a route can
   * raise its cap for an authenticated caller only.
   */
  maxBodyBytes?: number | ((headers: IncomingHttpHeaders) => number);
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

/**
 * A 413 that closes the connection. Send it only once the body has been read: closing while the
 * client is still uploading resets the socket, and the client sees ECONNRESET instead of the 413.
 */
export function payloadTooLarge(error: string): JsonResult {
  return { kind: 'json', status: 413, body: { error, code: 'too_large' }, headers: { connection: 'close' } };
}

/** Map a thrown value to a response: an {@link HttpError} keeps its status, anything else is a 500. */
export function errorResult(err: unknown): JsonResult {
  if (err instanceof HttpError) return httpError(err.status, err.message, err.code);
  return httpError(500, err instanceof Error ? err.message : 'internal error', 'internal');
}

/** Parse a raw body as JSON; an empty body is `null`. @throws {HttpError} 400 on invalid JSON. */
export function parseJsonBody<T>(raw: Buffer): T {
  try {
    return JSON.parse(raw.toString('utf8') || 'null') as T;
  } catch {
    throw new HttpError(400, 'request body is not valid JSON', 'bad_request');
  }
}

/** Parse a request target; null when it is not a valid URL. */
export function parseRequestUrl(url: string | undefined): URL | null {
  try {
    return new URL(url ?? '/', 'http://localhost');
  } catch {
    return null;
  }
}

/** The body cap that applies to `route` for a request with these headers. */
export function bodyLimit(route: Pick<OtaRoute, 'maxBodyBytes'>, headers: IncomingHttpHeaders): number {
  const cap = typeof route.maxBodyBytes === 'function' ? route.maxBodyBytes(headers) : route.maxBodyBytes;
  return cap ?? DEFAULT_MAX_BODY_BYTES;
}

/**
 * Buffer a request body up to `limit` bytes. A body over the limit (declared or actual) is read to
 * the end and discarded, so the caller can answer 413 without resetting a client mid-upload.
 *
 * @returns the body, or null when it exceeded the limit.
 */
export function readBody(req: IncomingMessage, limit: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    let over = Number.isFinite(declared) && declared > limit;
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      if (over) return;
      size += chunk.length;
      if (size > limit) {
        over = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(over ? null : Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * Answer a request whose body will not be used, without buffering it. A declared body within
 * {@link DEFAULT_MAX_BODY_BYTES} is discarded first so the client reads a clean response; a larger
 * or unsized one is not read, and the connection is closed. Leaving it unread on a kept-alive
 * connection stalls the client's upload on Node 20.
 */
export function answerUnread(req: IncomingMessage, res: ServerResponse, result: HandlerResult): void {
  const declared = Number(req.headers['content-length'] ?? 0);
  const unsized = req.headers['transfer-encoding'] !== undefined;
  if (req.readableEnded || (!unsized && declared === 0)) {
    writeNodeResult(res, result);
  } else if (!unsized && declared <= DEFAULT_MAX_BODY_BYTES) {
    req.on('end', () => writeNodeResult(res, result));
    req.on('error', () => res.destroy());
    req.resume();
  } else {
    writeNodeResult(res, { ...result, headers: { ...result.headers, connection: 'close' } });
  }
}

/** Decode one path segment; null when its percent-encoding is malformed. */
function decodeSegment(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

/** A matched route with its decoded `:name` parameters. */
export interface RouteMatch<R> {
  route: R;
  params: Record<string, string>;
}

/**
 * Find the route for a request, shared by every adapter so they agree on what matches.
 *
 * Literal segments beat parameters at the same position, so a literal route can coexist with a
 * parameterised one.
 *
 * @returns the match, `'malformed'` when the path fits a route but a parameter cannot be decoded,
 *   or null when nothing fits.
 */
export function matchRoute<R extends { method: string; path: string }>(
  routes: readonly R[],
  method: string,
  pathname: string,
): RouteMatch<R> | 'malformed' | null {
  const parts = pathname.split('/');
  let best: (RouteMatch<R> & { exactness: number }) | null = null;
  let malformed = false;
  for (const route of routes) {
    const segments = route.path.split('/');
    if (route.method !== method || segments.length !== parts.length) continue;
    if (segments.some((seg, i) => !seg.startsWith(':') && seg !== parts[i])) continue;
    const params: Record<string, string> = {};
    let decoded = true;
    segments.forEach((seg, i) => {
      if (!seg.startsWith(':')) return;
      const value = decodeSegment(parts[i] as string);
      if (value === null) decoded = false;
      else params[seg.slice(1)] = value;
    });
    if (!decoded) {
      malformed = true;
      continue;
    }
    const exactness = segments.filter((seg) => !seg.startsWith(':')).length;
    if (!best || exactness > best.exactness) best = { route, params, exactness };
  }
  if (best) return { route: best.route, params: best.params };
  return malformed ? 'malformed' : null;
}

/** Write a {@link HandlerResult} to a `node:http` (or Express) `ServerResponse`. */
export function writeNodeResult(res: ServerResponse, result: HandlerResult): void {
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

/** One registered route. */
interface RouterRoute {
  method: string;
  path: string;
  handler: Handler;
  streamBody: boolean;
  maxBodyBytes?: OtaRoute['maxBodyBytes'];
}

/**
 * @param result - a handler's result.
 * @returns the HTTP status it will be written with.
 */
function resultStatus(result: HandlerResult): number {
  return 'status' in result && typeof result.status === 'number' ? result.status : 200;
}

/** A minimal router supporting exact paths and `:name` parameters. */
export class Router {
  private readonly routes: RouterRoute[] = [];

  /** Register a handler for `METHOD path`. */
  on(method: string, path: string, handler: Handler, streamBody = false): this {
    this.routes.push({ method: method.toUpperCase(), path, handler, streamBody });
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
    for (const r of routes) {
      this.routes.push({
        method: r.method.toUpperCase(),
        path: r.path,
        handler: r.handler,
        streamBody: r.streamBody ?? false,
        maxBodyBytes: r.maxBodyBytes,
      });
    }
    return this;
  }

  /** Start an HTTP server bound to `port`. Resolves once listening. */
  listen(port: number): Promise<Server> {
    const server = createServer((req, res) => this.handle(req, res));
    return new Promise((resolve) => server.listen(port, () => resolve(server)));
  }

  /** Answer one request. The route is resolved before any of the body is read. */
  private handle(req: IncomingMessage, res: ServerResponse): void {
    const method = (req.method ?? 'GET').toUpperCase();
    const parsed = parseRequestUrl(req.url);
    const matched = parsed ? matchRoute(this.routes, method, parsed.pathname) : 'malformed';
    if (!parsed || matched === 'malformed') {
      answerUnread(req, res, httpError(400, 'malformed request path', 'bad_request'));
      return;
    }
    if (!matched) {
      answerUnread(req, res, httpError(404, `no route for ${method} ${parsed.pathname}`, 'not_found'));
      return;
    }

    const run = (rawBody: Buffer, body?: Readable): void => {
      void this.run(matched, method, parsed, req.headers, rawBody, body, req.socket.remoteAddress)
        .then((result) => this.write(res, result))
        .catch((err: unknown) => this.write(res, errorResult(err)));
    };
    // A streaming route must receive the body unread, so the handler can enforce its cap as the
    // bytes arrive rather than after they are all in memory.
    if (matched.route.streamBody) {
      run(Buffer.alloc(0), req);
      return;
    }
    const limit = bodyLimit(matched.route, req.headers);
    void readBody(req, limit).then(
      (rawBody) => (rawBody ? run(rawBody) : this.write(res, payloadTooLarge(`request body exceeds ${limit} bytes`))),
      () => this.write(res, httpError(400, 'bad request', 'bad_request')),
    );
  }

  /** Resolve a route and run it (also reachable directly from tests). */
  async dispatch(
    method: string,
    url: string,
    headers: IncomingHttpHeaders,
    rawBody: Buffer,
    body?: Readable,
  ): Promise<HandlerResult> {
    const upper = method.toUpperCase();
    const parsed = parseRequestUrl(url);
    const matched = parsed ? matchRoute(this.routes, upper, parsed.pathname) : 'malformed';
    if (!parsed || matched === 'malformed') return httpError(400, 'malformed request path', 'bad_request');
    if (!matched) return httpError(404, `no route for ${method} ${parsed.pathname}`, 'not_found');
    return this.run(matched, upper, parsed, headers, rawBody, body);
  }

  /** Build the context for a matched route and run its handler. */
  private async run(
    matched: RouteMatch<RouterRoute>,
    method: string,
    parsed: URL,
    headers: IncomingHttpHeaders,
    rawBody: Buffer,
    body?: Readable,
    remoteAddress?: string,
  ): Promise<HandlerResult> {
    const ctx: ReqCtx = {
      method,
      path: parsed.pathname,
      query: parsed.searchParams,
      headers,
      rawBody,
      params: matched.params,
      ...(remoteAddress ? { remoteAddress } : {}),
      ...(body ? { body } : {}),
      json<T>(): T {
        return parseJsonBody<T>(rawBody);
      },
    };
    const result = await matched.route.handler(ctx);
    this.accessLog?.(ctx.method, ctx.path, resultStatus(result));
    return result;
  }

  /**
   * Optional access log, called once per dispatched request with its final status.
   *
   * Off by default: a library that writes to someone else's stdout is a nuisance. The standalone
   * server turns it on when `OTA_ACCESS_LOG=true`, which is how you see which blobs a device
   * actually fetched — the difference between a device reusing a file and re-downloading it is
   * invisible from the client side.
   */
  accessLog?: (method: string, path: string, status: number) => void;

  private write(res: ServerResponse, result: HandlerResult): void {
    writeNodeResult(res, result);
  }
}
