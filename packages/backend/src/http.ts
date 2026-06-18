/**
 * A tiny dependency-free HTTP router over `node:http`. Deliberately minimal — keeping the
 * backend's dependency (and supply-chain) surface near zero is on-theme for a security
 * project, and this layer is trivially replaceable when the POC becomes a real microservice.
 *
 * @module http
 */

import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { URL } from 'node:url';

/** Per-request context passed to handlers. */
export interface ReqCtx {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingHttpHeaders;
  rawBody: Buffer;
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

/** A binary response (used to stream the encrypted bundle). */
export interface BinaryResult {
  kind: 'binary';
  status?: number;
  contentType: string;
  body: Buffer;
  headers?: Record<string, string>;
}

export type HandlerResult = JsonResult | BinaryResult;
export type Handler = (ctx: ReqCtx) => Promise<HandlerResult> | HandlerResult;

/** A framework-agnostic route: method + exact path + handler. Consumed by every adapter. */
export interface OtaRoute {
  method: 'GET' | 'POST';
  path: string;
  handler: Handler;
}

/** Build a JSON response. */
export function json(body: unknown, status = 200, headers?: Record<string, string>): JsonResult {
  return { kind: 'json', status, body, headers };
}

/** Build a binary response. */
export function binary(body: Buffer, contentType = 'application/octet-stream', status = 200): BinaryResult {
  return { kind: 'binary', status, contentType, body };
}

/** Build a JSON error response. */
export function httpError(status: number, error: string, code?: string): JsonResult {
  return { kind: 'json', status, body: { error, code } };
}

/** Write a {@link HandlerResult} to a `node:http` (or Express) `ServerResponse`. */
export function writeNodeResult(res: import('node:http').ServerResponse, result: HandlerResult): void {
  const status = result.status ?? 200;
  if (result.kind === 'binary') {
    res.writeHead(status, { 'content-type': result.contentType, ...(result.headers ?? {}) });
    res.end(result.body);
    return;
  }
  res.writeHead(status, { 'content-type': 'application/json', ...(result.headers ?? {}) });
  res.end(JSON.stringify(result.body));
}

/** A minimal exact-path router. */
export class Router {
  private readonly routes = new Map<string, Handler>();

  /** Register a handler for `METHOD path`. */
  on(method: string, path: string, handler: Handler): this {
    this.routes.set(`${method.toUpperCase()} ${path}`, handler);
    return this;
  }

  get(path: string, handler: Handler): this {
    return this.on('GET', path, handler);
  }

  post(path: string, handler: Handler): this {
    return this.on('POST', path, handler);
  }

  /** Register a batch of framework-agnostic routes. */
  register(routes: readonly OtaRoute[]): this {
    for (const r of routes) this.on(r.method, r.path, r.handler);
    return this;
  }

  /** Start an HTTP server bound to `port`. Resolves once listening. */
  listen(port: number): Promise<Server> {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        void this.dispatch(req.method ?? 'GET', req.url ?? '/', req.headers, Buffer.concat(chunks))
          .then((result) => this.write(res, result))
          .catch((err: unknown) => {
            const message = err instanceof Error ? err.message : 'internal error';
            this.write(res, httpError(500, message, 'internal'));
          });
      });
      req.on('error', () => this.write(res, httpError(400, 'bad request')));
    });
    return new Promise((resolve) => server.listen(port, () => resolve(server)));
  }

  /** Resolve a route and run it (also reachable directly from tests). */
  async dispatch(method: string, url: string, headers: IncomingHttpHeaders, rawBody: Buffer): Promise<HandlerResult> {
    const parsed = new URL(url, 'http://localhost');
    const handler = this.routes.get(`${method.toUpperCase()} ${parsed.pathname}`);
    if (!handler) return httpError(404, `no route for ${method} ${parsed.pathname}`, 'not_found');
    const ctx: ReqCtx = {
      method: method.toUpperCase(),
      path: parsed.pathname,
      query: parsed.searchParams,
      headers,
      rawBody,
      json<T>(): T {
        return JSON.parse(rawBody.toString('utf8') || 'null') as T;
      },
    };
    return handler(ctx);
  }

  private write(res: import('node:http').ServerResponse, result: HandlerResult): void {
    writeNodeResult(res, result);
  }
}
