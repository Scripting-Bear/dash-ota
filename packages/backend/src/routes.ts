/**
 * Framework-agnostic OTA route definitions. These handlers operate on a normalized
 * {@link ReqCtx} (method/path/headers/rawBody) and return a normalized {@link HandlerResult},
 * so the **same** logic powers the standalone `node:http` server and the Connect/Express
 * middleware without duplication. All host-pluggable behaviour (auth, analytics, logging)
 * comes in through {@link BackendConfig} hooks, and all storage through the {@link Store}'s
 * providers.
 *
 * @module routes
 */

import type { IncomingHttpHeaders } from 'node:http';
import {
  collectBlobShas,
  findBlobEntry,
  totalBlobBytes,
  type CheckRequestV2,
  type CheckResponse,
  type ConfirmRequest,
  type ConfirmStatus,
  type DeviceContext,
  type EnrollRequest,
  constantTimeEqualStr,
  OTA_HEADERS,
  publicKeyFromRawB64,
  sha256Hex,
  type SignedManifest,
  validateManifestShape,
  verifyManifest,
  verifyRequestEcdsa,
} from '@dash-ota/shared';
import { type BackendConfig, DEFAULT_MAX_ADMIN_BODY_BYTES } from './config.js';
import {
  binaryStream,
  DEFAULT_MAX_BODY_BYTES,
  type HandlerResult,
  HttpError,
  httpError,
  json,
  type OtaRoute,
  parseRange,
  payloadTooLarge,
  type ReqCtx,
} from './http.js';
import { drain } from './upload.js';
import { isValidChannel, isValidStoreUrl, Store } from './store.js';

/** Read a single header as a string. */
function header(ctx: ReqCtx, name: string): string | undefined {
  return headerValue(ctx.headers, name);
}

/** Read a single header from raw headers. */
function headerValue(headers: IncomingHttpHeaders, name: string): string | undefined {
  const v = headers[name];
  return Array.isArray(v) ? v[0] : v;
}

/** Parse the body as a JSON object. @throws {HttpError} 400 for an empty, array or scalar body. */
function objectBody<T>(ctx: ReqCtx): T {
  const body = ctx.json<unknown>();
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'request body must be a JSON object', 'bad_request');
  }
  return body as T;
}

/** A non-empty string. */
function isText(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

const CONFIRM_STATUSES: ReadonlySet<unknown> = new Set<ConfirmStatus>(['applied', 'healthy', 'failed', 'rolled_back']);

/** Answer a thrown {@link HttpError} with its status, whichever adapter serves the route. */
function answerHttpErrors(handler: OtaRoute['handler']): OtaRoute['handler'] {
  return async (ctx) => {
    try {
      return await handler(ctx);
    } catch (err) {
      if (err instanceof HttpError) return httpError(err.status, err.message, err.code);
      throw err;
    }
  };
}

/** A 400 for a body that parsed but does not have the expected fields. */
function badRequest(error: string): HandlerResult {
  return httpError(400, error, 'bad_request');
}

/** True if the result is an early-return error (vs. an authenticated principal). */
function isError(v: { installId: string } | HandlerResult): v is HandlerResult {
  return 'kind' in v || 'body' in v;
}

/**
 * Authenticate a request via the device's hardware key (ECDSA-P256), with a timestamp window
 * and a nonce replay-guard (backed by the {@link CacheProvider}). No shared secret is involved —
 * we verify the signature against the public key registered at enrollment.
 */
async function authenticate(ctx: ReqCtx, store: Store, config: BackendConfig): Promise<{ installId: string } | HandlerResult> {
  const installId = header(ctx, OTA_HEADERS.installId);
  if (!installId) return httpError(401, 'missing install id', 'unauthenticated');
  if (!config.requireRequestSignature) return { installId };

  const nonce = header(ctx, OTA_HEADERS.nonce);
  const timestamp = header(ctx, OTA_HEADERS.timestamp);
  const signature = header(ctx, OTA_HEADERS.signature);
  if (!nonce || !timestamp || !signature) return httpError(401, 'missing signature headers', 'unauthenticated');

  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > config.timestampSkewMs) {
    return httpError(401, 'stale or invalid timestamp', 'stale_timestamp');
  }

  const devicePublicKeyB64 = await store.getDevicePublicKey(installId);
  if (!devicePublicKeyB64) return httpError(401, 'install not enrolled', 'not_enrolled');

  const ok = verifyRequestEcdsa(
    devicePublicKeyB64,
    { method: ctx.method, path: ctx.path, installId, nonce, timestamp, bodySha256: sha256Hex(ctx.rawBody) },
    signature,
  );
  if (!ok) return httpError(401, 'bad request signature', 'bad_signature');

  // Register the nonce (replay guard) LAST — only for a validly-signed request — so a forged
  // signature can't fill the nonce cache or force work with an unauthenticated request.
  if (!(await store.registerNonce(nonce))) return httpError(401, 'replayed nonce', 'replay');
  return { installId };
}

/**
 * Enforce a fixed-window rate limit for `scope`/`identity`. Returns a `429` result (with a
 * `Retry-After` header) when the limit is exceeded, else `null` to continue.
 */
async function rateLimited(
  store: Store,
  config: BackendConfig,
  scope: string,
  identity: string,
  limit: number,
): Promise<HandlerResult | null> {
  const r = await store.rateLimit(scope, identity, limit, config.rateLimitWindowMs);
  if (r.allowed) return null;
  return json({ error: 'rate limit exceeded', code: 'rate_limited' }, 429, {
    'retry-after': String(Math.ceil(r.resetMs / 1000)),
  });
}

/** Whether the request carries the admin token, compared in constant time. */
function isAdmin(headers: IncomingHttpHeaders, config: BackendConfig): boolean {
  return !!config.adminToken && constantTimeEqualStr(headerValue(headers, 'x-ota-admin-token') ?? '', config.adminToken);
}

/** Require the admin token (CLI publish / console), compared in constant time. */
function requireAdmin(ctx: ReqCtx, config: BackendConfig): HandlerResult | null {
  if (!config.adminToken) return httpError(503, 'admin endpoints disabled: set OTA_ADMIN_TOKEN', 'admin_disabled');
  if (!isAdmin(ctx.headers, config)) return httpError(403, 'admin token required', 'forbidden');
  return null;
}

/**
 * Invoke a host hook so it cannot affect the response or the process: a throw or a rejected
 * promise is logged, never propagated.
 */
function runHook(config: BackendConfig, name: string, invoke: () => unknown): void {
  const report = (err: unknown): void => {
    const message = `${name} hook failed: ${err instanceof Error ? err.message : String(err)}`;
    if (config.logger) config.logger.error(message);
    else console.error(`[dash-ota] ${message}`);
  };
  try {
    const result = invoke();
    if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
      (result as PromiseLike<unknown>).then(undefined, report);
    }
  } catch (err) {
    report(err);
  }
}

/** Resolve whether an enroll is authorized (custom hook wins; else presence-only default check). */
async function enrollAuthorized(body: EnrollRequest, config: BackendConfig): Promise<boolean> {
  if (config.verifyEnrollToken) {
    return config.verifyEnrollToken(body.enrollToken, {
      installId: body.installId,
      platform: body.platform,
      channel: body.channel,
      appVersion: body.appVersion,
      buildNumber: body.buildNumber,
      attestationToken: body.attestationToken,
      keyHardwareBacked: body.keyHardwareBacked,
    });
  }
  return !config.requireEnrollAuth || !!body.enrollToken;
}

/**
 * Build the full set of OTA + admin routes against a store and config. Framework-agnostic:
 * pass the result to {@link Router.register} (node:http) or {@link dashOtaMiddleware}
 * (Connect/Express).
 *
 * @param store persistence + lookup layer (disk-backed by default; bring your own providers)
 * @param config resolved backend config, including pluggable hooks
 * @returns the ordered list of routes
 */
export function createOtaRoutes(store: Store, config: BackendConfig): OtaRoute[] {
  const log = config.logger;
  const routes: OtaRoute[] = [];
  // The large cap applies only once the admin token checks out, so an anonymous caller cannot make
  // the server buffer a manifest-sized body.
  const adminBodyLimit = (headers: IncomingHttpHeaders): number =>
    isAdmin(headers, config) ? (config.maxAdminBodyBytes ?? DEFAULT_MAX_ADMIN_BODY_BYTES) : DEFAULT_MAX_BODY_BYTES;

  // Liveness: the process is up. MUST NOT touch dependencies — a liveness probe should not fail
  // (and trigger a restart) just because the database is briefly unreachable.
  const health: OtaRoute['handler'] = () => json({ ok: true });
  routes.push({ method: 'GET', path: '/health', handler: health });
  routes.push({ method: 'HEAD', path: '/health', handler: health });

  // Readiness: can we actually serve? Touches the store, so a load balancer can pull this instance
  // out of rotation when its database/backing store is unreachable. 503 when not ready.
  const ready: OtaRoute['handler'] = async () => {
    try {
      const releases = (await store.listReleases()).length;
      return json({ ready: true, releases });
    } catch (err) {
      log?.warn(`readiness check failed: ${err instanceof Error ? err.message : 'store unreachable'}`);
      return json({ ready: false, error: 'store unreachable' }, 503);
    }
  };
  routes.push({ method: 'GET', path: '/ready', handler: ready });
  routes.push({ method: 'HEAD', path: '/ready', handler: ready });

  // --- client: enroll (register the device's hardware public key) -------
  routes.push({
    method: 'POST',
    path: '/ota/v2/enroll',
    handler: async (ctx) => {
      const body = objectBody<EnrollRequest>(ctx);
      if (!isText(body.installId) || !isText(body.platform) || !isText(body.channel) || !isText(body.devicePublicKeyB64)) {
        return badRequest('invalid enroll body');
      }
      // Authenticated enrollment ties the device key to a real user session. The host wires
      // its auth via `verifyEnrollToken`; the default just requires a token's presence.
      if (!(await enrollAuthorized(body, config))) {
        // Failures count per client address, never against the claimed installId, so they cannot lock
        // that device out. A caller that authenticates is never limited by this bucket.
        const limited = await rateLimited(store, config, 'enroll-fail', ctx.remoteAddress ?? 'unknown', config.enrollRateLimit);
        return limited ?? httpError(401, 'enroll requires an authenticated session', 'unauthenticated');
      }
      const limited = await rateLimited(store, config, 'enroll', body.installId, config.enrollRateLimit);
      if (limited) return limited;
      await store.enroll(body.installId, body.platform, body.channel, body.devicePublicKeyB64);
      log?.info(`enrolled install ${body.installId} (${body.platform}/${body.channel})`);
      return json({ ok: true });
    },
  });

  // --- client: check for update ----------------------------------------
  routes.push({
    method: 'POST',
    path: '/ota/v2/check',
    handler: async (ctx) => {
      const auth = await authenticate(ctx, store, config);
      if (isError(auth)) return auth;
      // Rate-limit the authenticated install (not the raw header) so a spoofed installId can't
      // burn a victim's budget; cross-install / CPU-flood protection belongs at the proxy.
      const limited = await rateLimited(store, config, 'check', auth.installId, config.checkRateLimit);
      if (limited) return limited;
      const body = objectBody<CheckRequestV2>(ctx);
      if (!isText(body.runtimeVersion) || !isText(body.platform) || !isText(body.channel)) {
        return badRequest('invalid check body');
      }

      const device: DeviceContext = {
        platform: body.platform,
        channel: body.channel,
        runtimeVersion: body.runtimeVersion,
        appVersion: body.appVersion,
        buildNumber: body.buildNumber,
        currentBundleVersion: body.currentBundleVersion ?? 0,
        installId: auth.installId,
      };

      const nativePolicy = await store.resolveNativePolicy(device.channel, device.buildNumber);
      const release = await store.pickEligible(device);
      const currentBundleId = typeof body.currentBundleId === 'string' ? body.currentBundleId : '';
      const scope = {
        platform: device.platform,
        channel: device.channel,
        runtimeVersion: device.runtimeVersion,
        currentBundleVersion: device.currentBundleVersion,
      };
      if (!release) {
        const serverNonce = await store.issueServerNonce(auth.installId, { ...scope, bundleIds: [currentBundleId] });
        const resp: CheckResponse = { update: null, serverNonce, nativePolicy };
        return json(resp);
      }
      const resp: CheckResponse = {
        update: release.signedManifest,
        downloadToken: await store.issueDownloadToken(release.bundleId, auth.installId),
        serverNonce: await store.issueServerNonce(auth.installId, { ...scope, bundleIds: [release.bundleId, currentBundleId] }),
        nativePolicy,
      };
      return json(resp);
    },
  });

  // --- client: download ciphertext (download token, no S3 URL) ---------
  routes.push({
    method: 'GET',
    path: '/ota/v2/releases/:bundleId/blobs/:blobSha256',
    handler: async (ctx) => {
      // Header only — never accept the token via query string, where it would leak into proxy
      // access logs and Referer headers.
      //
      // No device-key signature here, deliberately: the token is short-lived and scoped to one
      // release, and the payload is independently authenticated by the per-blob hash in the signed
      // manifest. Signing every blob request would add a round of crypto per file and buy nothing.
      const token = header(ctx, OTA_HEADERS.downloadToken) ?? '';
      const grant = await store.peekDownloadToken(token);
      if (!grant) return httpError(403, 'invalid or expired download token', 'bad_token');

      const bundleId = ctx.params.bundleId ?? '';
      const blobSha256 = ctx.params.blobSha256 ?? '';
      if (grant.bundleId !== bundleId) {
        return httpError(403, 'token is not valid for this release', 'token_scope');
      }

      const record = await store.getRelease(bundleId);
      if (!record) return httpError(404, 'unknown release', 'not_found');
      // A rolled-back release must stop serving even to a device holding a live token.
      if (record.paused || record.rolledBack) return httpError(410, 'release is no longer available', 'gone');
      if (!findBlobEntry(record.signedManifest.manifest, blobSha256)) {
        return httpError(404, 'this release does not reference that blob', 'not_found');
      }

      const stat = await store.statBlob(bundleId, blobSha256);
      if (!stat) return httpError(404, 'blob missing', 'not_found');

      // Blobs are content-addressed and therefore immutable, so they are safe to cache forever.
      const headers: Record<string, string> = {
        etag: `"${blobSha256}"`,
        'cache-control': 'public, max-age=31536000, immutable',
        'accept-ranges': 'bytes',
      };

      const range = parseRange(header(ctx, 'range'), stat.size);
      if (range === 'unsatisfiable') {
        return {
          kind: 'json',
          status: 416,
          body: { error: 'range not satisfiable' },
          headers: { ...headers, 'content-range': `bytes */${stat.size}` },
        };
      }
      const stream = await store.openBlobStream(bundleId, blobSha256, range ?? undefined);
      if (!stream) return httpError(404, 'blob missing', 'not_found');
      if (range) {
        return binaryStream(stream, range.end - range.start + 1, 'application/octet-stream', 206, {
          ...headers,
          'content-range': `bytes ${range.start}-${range.end}/${stat.size}`,
        });
      }
      return binaryStream(stream, stat.size, 'application/octet-stream', 200, headers);
    },
  });

  // --- client: confirm apply result ------------------------------------
  routes.push({
    method: 'POST',
    path: '/ota/v2/confirm',
    handler: async (ctx) => {
      const auth = await authenticate(ctx, store, config);
      if (isError(auth)) return auth;
      const body = objectBody<ConfirmRequest>(ctx);
      if (!isText(body.bundleId) || !CONFIRM_STATUSES.has(body.status)) return badRequest('invalid confirm body');
      if (!(await store.consumeServerNonce(body.serverNonce, auth.installId, body.bundleId, body.status))) {
        return httpError(401, 'invalid server nonce', 'bad_nonce');
      }
      const autoPaused = await store.recordConfirm(body.bundleId, body.status, auth.installId);
      const event = {
        installId: auth.installId,
        bundleId: body.bundleId,
        status: body.status,
        reason: typeof body.reason === 'string' ? body.reason : undefined,
        autoPaused,
      };
      runHook(config, 'onConfirm', () => config.onConfirm?.(event));
      return json({ ok: true, autoPaused });
    },
  });

  // --- admin / CLI: register a trusted public key -----------------------
  routes.push({
    method: 'POST',
    path: '/admin/keys',
    maxBodyBytes: adminBodyLimit,
    handler: async (ctx) => {
      const denied = requireAdmin(ctx, config);
      if (denied) return denied;
      const body = objectBody<{ keyId: unknown; publicKeyRawB64: unknown }>(ctx);
      if (!isText(body.keyId) || !isText(body.publicKeyRawB64)) return badRequest('keyId and publicKeyRawB64 required');
      await store.registerKey(body.keyId, body.publicKeyRawB64);
      log?.info(`registered signing key ${body.keyId}`);
      return json({ ok: true });
    },
  });

  // --- admin / CLI: publish, in three steps ----------------------------
  // Manifest first, then one blob at a time, then finalize. A release is invisible to devices
  // until every blob has landed, which is what lets an interrupted publish simply be re-run.
  routes.push({
    method: 'POST',
    path: '/admin/releases',
    maxBodyBytes: adminBodyLimit,
    handler: async (ctx) => {
      const denied = requireAdmin(ctx, config);
      if (denied) return denied;
      const body = objectBody<{ signedManifest?: SignedManifest; rolloutPercentage?: unknown }>(ctx);
      if (
        !body.signedManifest ||
        typeof body.signedManifest !== 'object' ||
        typeof body.signedManifest.signatureB64 !== 'string'
      ) {
        return badRequest('signedManifest required');
      }
      if (body.rolloutPercentage !== undefined && !Number.isFinite(body.rolloutPercentage)) {
        return badRequest('rolloutPercentage must be a number');
      }

      const { signedManifest } = body;
      // Defense-in-depth: reject a structurally-invalid manifest even if it is validly signed.
      const shapeErrors = validateManifestShape(signedManifest.manifest);
      if (shapeErrors.length > 0) return httpError(400, `invalid manifest: ${shapeErrors.join('; ')}`, 'bad_manifest');
      const rawKey = await store.getTrustedKey(signedManifest.keyId);
      if (!rawKey) return httpError(400, `unknown signing keyId ${signedManifest.keyId}`, 'unknown_key');
      if (!verifyManifest(signedManifest, publicKeyFromRawB64(rawKey))) {
        return httpError(400, 'manifest signature does not verify', 'bad_signature');
      }
      const total = totalBlobBytes(signedManifest.manifest);
      if (total > config.maxBundleBytes) {
        return httpError(413, `release exceeds the ${config.maxBundleBytes}-byte size cap`, 'too_large');
      }

      const rollout = typeof body.rolloutPercentage === 'number' ? body.rolloutPercentage : 100;
      const created = await store.createRelease(signedManifest, Math.max(0, Math.min(100, rollout)));
      if (!created.ok) return httpError(created.status, created.error, created.code);
      const { record, missing } = created;
      log?.info(
        `created ${record.bundleId} (${missing.length} of ${collectBlobShas(signedManifest.manifest).length} blobs to upload)`,
      );
      return json({ ok: true, bundleId: record.bundleId, missing });
    },
  });

  routes.push({
    method: 'PUT',
    path: '/admin/releases/:bundleId/blobs/:blobSha256',
    // Streamed: the cap has to be enforced as the bytes arrive, which is impossible once the body
    // has already been buffered.
    streamBody: true,
    handler: async (ctx) => {
      const denied = requireAdmin(ctx, config);
      if (denied) {
        if (ctx.body) await drain(ctx.body);
        return denied;
      }
      if (!ctx.body) return httpError(400, 'expected a request body');
      if (Number(header(ctx, 'content-length')) > config.maxBlobBytes) {
        await drain(ctx.body);
        return payloadTooLarge(`blob exceeds ${config.maxBlobBytes} bytes`);
      }
      const result = await store.stageBlob(ctx.params.bundleId ?? '', ctx.params.blobSha256 ?? '', ctx.body, config.maxBlobBytes);
      if (!result.ok) {
        // An unknown release or blob is refused before the body is read; answering over an unread
        // upload stalls or resets it, and the CLI retries that as a network fault.
        if (!ctx.body.readableEnded) await drain(ctx.body);
        return result.status === 413 ? payloadTooLarge(result.error) : httpError(result.status, result.error, result.code);
      }
      return json({ ok: true, already: result.already });
    },
  });

  routes.push({
    method: 'POST',
    path: '/admin/releases/:bundleId/finalize',
    maxBodyBytes: adminBodyLimit,
    handler: async (ctx) => {
      const denied = requireAdmin(ctx, config);
      if (denied) return denied;
      const result = await store.finalizeRelease(ctx.params.bundleId ?? '');
      if (!result.ok) {
        return { kind: 'json', status: result.status, body: { error: result.error, code: result.code, missing: result.missing } };
      }
      const { record } = result;
      if (!result.already) {
        const event = {
          bundleId: record.bundleId,
          platform: record.platform,
          channel: record.channel,
          bundleVersion: record.bundleVersion,
          runtimeVersion: record.runtimeVersion,
          rolloutPercentage: record.rolloutPercentage,
        };
        runHook(config, 'onPublish', () => config.onPublish?.(event));
        log?.info(
          `published ${record.bundleId} (${record.platform}/${record.channel} v${record.bundleVersion} @ ${record.rolloutPercentage}%)`,
        );
      }
      return json({ ok: true, bundleId: record.bundleId, rolloutPercentage: record.rolloutPercentage, already: result.already });
    },
  });

  // The CLI reads a base release's manifest from here to report what a device could reuse.
  routes.push({
    method: 'GET',
    path: '/admin/releases/:bundleId',
    handler: async (ctx) => {
      const denied = requireAdmin(ctx, config);
      if (denied) return denied;
      const record = await store.getRelease(ctx.params.bundleId ?? '');
      if (!record) return httpError(404, 'release not found');
      return json({ release: record });
    },
  });

  // --- retired clients: everything before protocol 2 --------------------
  // These speak a wire format this backend no longer serves. They get a clean "no update" plus a
  // hard native policy, so the app shows its store prompt instead of an error the user cannot act
  // on. Nothing is verified here: an old client cannot be expected to sign correctly, and there is
  // nothing to protect.
  const tombstone = (): OtaRoute['handler'] => async (ctx) => {
    const body = (() => {
      try {
        return ctx.json<{ channel?: unknown; platform?: unknown }>() ?? {};
      } catch {
        return {};
      }
    })();
    const channel = isValidChannel(body.channel) ? body.channel : 'unknown';
    const platform = typeof body.platform === 'string' ? body.platform : 'unknown';
    await store.recordRetiredClient(channel, platform);
    return json({
      update: null,
      serverNonce: '',
      nativePolicy: await store.retiredPolicy(channel),
    });
  };
  routes.push({ method: 'POST', path: '/ota/v1/check', handler: tombstone() });
  routes.push({ method: 'POST', path: '/ota/v1/enroll', handler: tombstone() });
  routes.push({
    method: 'GET',
    path: '/ota/v1/download',
    handler: async () => httpError(410, 'this server no longer serves the v1 format; update the app from the store', 'retired'),
  });
  routes.push({
    method: 'POST',
    path: '/ota/v1/confirm',
    handler: async () => httpError(410, 'this server no longer serves the v1 format; update the app from the store', 'retired'),
  });

  // --- admin / console: operate rollouts --------------------------------
  routes.push({
    method: 'GET',
    path: '/admin/releases',
    handler: async (ctx) => {
      const denied = requireAdmin(ctx, config);
      if (denied) return denied;
      return json({
        retiredClients: await store.getRetiredClients(),
        releases: (await store.listReleases()).map((r) => ({
          bundleId: r.bundleId,
          platform: r.platform,
          channel: r.channel,
          runtimeVersion: r.runtimeVersion,
          bundleVersion: r.bundleVersion,
          rolloutPercentage: r.rolloutPercentage,
          paused: r.paused,
          rolledBack: r.rolledBack,
          mandatory: r.signedManifest.manifest.mandatory,
          releaseNotes: r.signedManifest.manifest.releaseNotes,
          adoption: r.adoption,
          createdAt: r.createdAt,
          schema: r.schema,
          finalized: r.finalized,
          totalBytes: r.totalBytes,
        })),
      });
    },
  });

  routes.push({
    method: 'POST',
    path: '/admin/rollout',
    maxBodyBytes: adminBodyLimit,
    handler: async (ctx) => {
      const denied = requireAdmin(ctx, config);
      if (denied) return denied;
      const body = objectBody<{ bundleId: unknown; rolloutPercentage: unknown }>(ctx);
      if (!isText(body.bundleId) || typeof body.rolloutPercentage !== 'number' || !Number.isFinite(body.rolloutPercentage)) {
        return badRequest('bundleId and a numeric rolloutPercentage required');
      }
      return (await store.setRollout(body.bundleId, body.rolloutPercentage))
        ? json({ ok: true })
        : httpError(404, 'release not found');
    },
  });

  routes.push({
    method: 'POST',
    path: '/admin/pause',
    maxBodyBytes: adminBodyLimit,
    handler: async (ctx) => {
      const denied = requireAdmin(ctx, config);
      if (denied) return denied;
      const body = objectBody<{ bundleId: unknown; paused: unknown }>(ctx);
      if (!isText(body.bundleId) || typeof body.paused !== 'boolean') return badRequest('bundleId and a boolean paused required');
      return (await store.setPaused(body.bundleId, body.paused)) ? json({ ok: true }) : httpError(404, 'release not found');
    },
  });

  routes.push({
    method: 'POST',
    path: '/admin/rollback',
    maxBodyBytes: adminBodyLimit,
    handler: async (ctx) => {
      const denied = requireAdmin(ctx, config);
      if (denied) return denied;
      const body = objectBody<{ bundleId: unknown }>(ctx);
      if (!isText(body.bundleId)) return badRequest('bundleId required');
      return (await store.rollback(body.bundleId)) ? json({ ok: true }) : httpError(404, 'release not found');
    },
  });

  routes.push({
    method: 'POST',
    path: '/admin/native-policy',
    maxBodyBytes: adminBodyLimit,
    handler: async (ctx) => {
      const denied = requireAdmin(ctx, config);
      if (denied) return denied;
      const body = objectBody<{
        channel: unknown;
        minSupportedNativeVersion: unknown;
        severity: unknown;
        storeUrl?: unknown;
      }>(ctx);
      if (!isValidChannel(body.channel)) return badRequest('channel must match [A-Za-z0-9._-]{1,64}');
      const min = body.minSupportedNativeVersion;
      if (typeof min !== 'number' || !Number.isSafeInteger(min) || min < 0) {
        return badRequest('minSupportedNativeVersion must be a non-negative integer');
      }
      if (body.severity !== 'soft' && body.severity !== 'hard') {
        return badRequest("severity must be 'soft' or 'hard'");
      }
      // The policy is not covered by the manifest signature and apps open this URL from a blocking
      // gate, so it must be a well-formed store-scheme link. Any https host still passes.
      if (body.storeUrl !== undefined && !isValidStoreUrl(body.storeUrl)) {
        return badRequest('storeUrl must be an https://, market:// or itms-apps:// URL without credentials or whitespace');
      }
      await store.setNativePolicy(body.channel, {
        minSupportedNativeVersion: min,
        severity: body.severity,
        ...(body.storeUrl !== undefined ? { storeUrl: body.storeUrl } : {}),
      });
      return json({ ok: true });
    },
  });

  return routes.map((route) => ({ ...route, handler: answerHttpErrors(route.handler) }));
}
