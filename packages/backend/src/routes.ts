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

import {
  collectBlobShas,
  findBlobEntry,
  totalBlobBytes,
  type CheckRequest,
  type CheckResponse,
  type ConfirmRequest,
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
import type { BackendConfig } from './config.js';
import { binaryStream, type HandlerResult, httpError, json, type OtaRoute, parseRange, type ReqCtx } from './http.js';
import { drain } from './upload.js';
import { Store } from './store.js';

/** Read a single header as a string. */
function header(ctx: ReqCtx, name: string): string | undefined {
  const v = ctx.headers[name];
  return Array.isArray(v) ? v[0] : v;
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

/** Require the admin token (CLI publish / console), compared in constant time. */
function requireAdmin(ctx: ReqCtx, config: BackendConfig): HandlerResult | null {
  if (!config.adminToken) return httpError(503, 'admin endpoints disabled: set OTA_ADMIN_TOKEN', 'admin_disabled');
  const provided = header(ctx, 'x-ota-admin-token') ?? '';
  if (!constantTimeEqualStr(provided, config.adminToken)) return httpError(403, 'admin token required', 'forbidden');
  return null;
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
/** Schemes an app-store link may use. The client enforces the same list before opening one. */
const STORE_URL_SCHEMES = /^(https|market|itms-apps):\/\//;

export function createOtaRoutes(store: Store, config: BackendConfig): OtaRoute[] {
  const log = config.logger;
  const routes: OtaRoute[] = [];

  // Liveness: the process is up. MUST NOT touch dependencies — a liveness probe should not fail
  // (and trigger a restart) just because the database is briefly unreachable.
  routes.push({
    method: 'GET',
    path: '/health',
    handler: () => json({ ok: true }),
  });

  // Readiness: can we actually serve? Touches the store, so a load balancer can pull this instance
  // out of rotation when its database/backing store is unreachable. 503 when not ready.
  routes.push({
    method: 'GET',
    path: '/ready',
    handler: async () => {
      try {
        const releases = (await store.listReleases()).length;
        return json({ ready: true, releases });
      } catch (err) {
        log?.warn(`readiness check failed: ${err instanceof Error ? err.message : 'store unreachable'}`);
        return json({ ready: false, error: 'store unreachable' }, 503);
      }
    },
  });

  // --- client: enroll (register the device's hardware public key) -------
  routes.push({
    method: 'POST',
    path: '/ota/v2/enroll',
    handler: async (ctx) => {
      const body = ctx.json<EnrollRequest>();
      if (!body?.installId || !body.platform || !body.channel || !body.devicePublicKeyB64) {
        return httpError(400, 'invalid enroll body');
      }
      const limited = await rateLimited(store, config, 'enroll', body.installId, config.enrollRateLimit);
      if (limited) return limited;
      // Authenticated enrollment ties the device key to a real user session. The host wires
      // its auth via `verifyEnrollToken`; the default just requires a token's presence.
      if (!(await enrollAuthorized(body, config))) {
        return httpError(401, 'enroll requires an authenticated session', 'unauthenticated');
      }
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
      const body = ctx.json<CheckRequest>();
      if (!body?.runtimeVersion || !body.platform || !body.channel) return httpError(400, 'invalid check body');

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
      if (!release) {
        const resp: CheckResponse = { update: null, serverNonce: await store.issueServerNonce(auth.installId, ''), nativePolicy };
        return json(resp);
      }
      const resp: CheckResponse = {
        update: release.signedManifest,
        downloadToken: await store.issueDownloadToken(release.bundleId, auth.installId),
        serverNonce: await store.issueServerNonce(auth.installId, release.bundleId),
        nativePolicy,
      };
      return json(resp);
    },
  });

  // --- client: download ciphertext (one-time token, no S3 URL) ----------
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
      const body = ctx.json<ConfirmRequest>();
      if (!body?.bundleId || !body.status) return httpError(400, 'invalid confirm body');
      if (!(await store.consumeServerNonce(body.serverNonce, auth.installId, body.bundleId))) {
        return httpError(401, 'invalid server nonce', 'bad_nonce');
      }
      const autoPaused = await store.recordConfirm(body.bundleId, body.status);
      config.onConfirm?.({
        installId: auth.installId,
        bundleId: body.bundleId,
        status: body.status,
        reason: body.reason,
        autoPaused,
      });
      return json({ ok: true, autoPaused });
    },
  });

  // --- admin / CLI: register a trusted public key -----------------------
  routes.push({
    method: 'POST',
    path: '/admin/keys',
    handler: async (ctx) => {
      const denied = requireAdmin(ctx, config);
      if (denied) return denied;
      const body = ctx.json<{ keyId: string; publicKeyRawB64: string }>();
      if (!body?.keyId || !body.publicKeyRawB64) return httpError(400, 'keyId and publicKeyRawB64 required');
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
    handler: async (ctx) => {
      const denied = requireAdmin(ctx, config);
      if (denied) return denied;
      const body = ctx.json<{ signedManifest: SignedManifest; rolloutPercentage?: number }>();
      if (!body?.signedManifest) return httpError(400, 'signedManifest required');

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

      const created = await store.createRelease(signedManifest, Math.max(0, Math.min(100, body.rolloutPercentage ?? 100)));
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
      const result = await store.stageBlob(ctx.params.bundleId ?? '', ctx.params.blobSha256 ?? '', ctx.body, config.maxBlobBytes);
      if (!result.ok) return httpError(result.status, result.error, result.code);
      return json({ ok: true, already: result.already });
    },
  });

  routes.push({
    method: 'POST',
    path: '/admin/releases/:bundleId/finalize',
    handler: async (ctx) => {
      const denied = requireAdmin(ctx, config);
      if (denied) return denied;
      const result = await store.finalizeRelease(ctx.params.bundleId ?? '');
      if (!result.ok) {
        return { kind: 'json', status: result.status, body: { error: result.error, code: result.code, missing: result.missing } };
      }
      const { record } = result;
      if (!result.already) {
        config.onPublish?.({
          bundleId: record.bundleId,
          platform: record.platform,
          channel: record.channel,
          bundleVersion: record.bundleVersion,
          runtimeVersion: record.runtimeVersion,
          rolloutPercentage: record.rolloutPercentage,
        });
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
        return ctx.json<{ channel?: string; platform?: string }>() ?? {};
      } catch {
        return {};
      }
    })();
    const channel = typeof body.channel === 'string' ? body.channel : 'unknown';
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
    handler: async (ctx) => {
      const denied = requireAdmin(ctx, config);
      if (denied) return denied;
      const body = ctx.json<{ bundleId: string; rolloutPercentage: number }>();
      return (await store.setRollout(body.bundleId, body.rolloutPercentage))
        ? json({ ok: true })
        : httpError(404, 'release not found');
    },
  });

  routes.push({
    method: 'POST',
    path: '/admin/pause',
    handler: async (ctx) => {
      const denied = requireAdmin(ctx, config);
      if (denied) return denied;
      const body = ctx.json<{ bundleId: string; paused: boolean }>();
      return (await store.setPaused(body.bundleId, body.paused)) ? json({ ok: true }) : httpError(404, 'release not found');
    },
  });

  routes.push({
    method: 'POST',
    path: '/admin/rollback',
    handler: async (ctx) => {
      const denied = requireAdmin(ctx, config);
      if (denied) return denied;
      const body = ctx.json<{ bundleId: string }>();
      return (await store.rollback(body.bundleId)) ? json({ ok: true }) : httpError(404, 'release not found');
    },
  });

  routes.push({
    method: 'POST',
    path: '/admin/native-policy',
    handler: async (ctx) => {
      const denied = requireAdmin(ctx, config);
      if (denied) return denied;
      const body = ctx.json<{
        channel: string;
        minSupportedNativeVersion: number;
        severity: 'soft' | 'hard';
        storeUrl?: string;
      }>();
      if (!body?.channel) return httpError(400, 'channel required');
      if (!Number.isInteger(body.minSupportedNativeVersion) || body.minSupportedNativeVersion < 0) {
        return httpError(400, 'minSupportedNativeVersion must be a non-negative integer');
      }
      if (body.severity !== 'soft' && body.severity !== 'hard') {
        return httpError(400, "severity must be 'soft' or 'hard'");
      }
      // The policy is not covered by the manifest signature, and apps open this URL from a
      // blocking gate. Refuse anything that is not a store link, so a leaked admin token cannot
      // point every install at an arbitrary page.
      if (body.storeUrl !== undefined && !STORE_URL_SCHEMES.test(body.storeUrl)) {
        return httpError(400, 'storeUrl must start with https://, market:// or itms-apps://');
      }
      await store.setNativePolicy(body.channel, {
        minSupportedNativeVersion: body.minSupportedNativeVersion,
        severity: body.severity,
        ...(body.storeUrl !== undefined ? { storeUrl: body.storeUrl } : {}),
      });
      return json({ ok: true });
    },
  });

  return routes;
}
