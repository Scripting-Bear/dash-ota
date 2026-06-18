/**
 * Framework-agnostic OTA route definitions. These handlers operate on a normalized
 * {@link ReqCtx} (method/path/headers/rawBody) and return a normalized {@link HandlerResult},
 * so the **same** logic powers the standalone `node:http` server and the Connect/Express
 * middleware without duplication. All host-pluggable behaviour (auth, analytics, logging)
 * comes in through {@link BackendConfig} hooks.
 *
 * @module routes
 */

import {
  type CheckRequest,
  type CheckResponse,
  type ConfirmRequest,
  type DeviceContext,
  type EnrollRequest,
  OTA_HEADERS,
  publicKeyFromRawB64,
  sha256Hex,
  type SignedManifest,
  verifyManifest,
  verifyRequestEcdsa,
} from '@dash-ota/shared';
import type { BackendConfig } from './config.js';
import { binary, type HandlerResult, httpError, json, type OtaRoute, type ReqCtx } from './http.js';
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
 * and an in-memory nonce replay-guard. No shared secret is involved — we verify the signature
 * against the public key registered at enrollment.
 */
function authenticate(ctx: ReqCtx, store: Store, config: BackendConfig): { installId: string } | HandlerResult {
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
  if (!store.registerNonce(nonce)) return httpError(401, 'replayed nonce', 'replay');

  const devicePublicKeyB64 = store.getDevicePublicKey(installId);
  if (!devicePublicKeyB64) return httpError(401, 'install not enrolled', 'not_enrolled');

  const ok = verifyRequestEcdsa(
    devicePublicKeyB64,
    { method: ctx.method, path: ctx.path, installId, nonce, timestamp, bodySha256: sha256Hex(ctx.rawBody) },
    signature,
  );
  if (!ok) return httpError(401, 'bad request signature', 'bad_signature');
  return { installId };
}

/** Require the admin token (CLI publish / console). */
function requireAdmin(ctx: ReqCtx, config: BackendConfig): HandlerResult | null {
  if (header(ctx, 'x-ota-admin-token') !== config.adminToken) return httpError(403, 'admin token required', 'forbidden');
  return null;
}

/** Resolve whether an enroll is authorized (custom hook wins; else presence-only POC check). */
async function enrollAuthorized(body: EnrollRequest, config: BackendConfig): Promise<boolean> {
  if (config.verifyEnrollToken) {
    return config.verifyEnrollToken(body.enrollToken, {
      installId: body.installId,
      platform: body.platform,
      channel: body.channel,
      appVersion: body.appVersion,
      buildNumber: body.buildNumber,
    });
  }
  return !config.requireEnrollAuth || !!body.enrollToken;
}

/**
 * Build the full set of OTA + admin routes against a store and config. Framework-agnostic:
 * pass the result to {@link Router.register} (node:http) or {@link dashOtaMiddleware}
 * (Connect/Express).
 *
 * @param store persistence + lookup layer (disk-backed by default; bring your own)
 * @param config resolved backend config, including pluggable hooks
 * @returns the ordered list of routes
 */
export function createOtaRoutes(store: Store, config: BackendConfig): OtaRoute[] {
  const log = config.logger;
  const routes: OtaRoute[] = [];

  routes.push({ method: 'GET', path: '/health', handler: () => json({ ok: true, releases: store.listReleases().length }) });

  // --- client: enroll (register the device's hardware public key) -------
  routes.push({
    method: 'POST',
    path: '/ota/v1/enroll',
    handler: async (ctx) => {
      const body = ctx.json<EnrollRequest>();
      if (!body?.installId || !body.platform || !body.channel || !body.devicePublicKeyB64) {
        return httpError(400, 'invalid enroll body');
      }
      // Authenticated enrollment ties the device key to a real user session. The host wires
      // its auth via `verifyEnrollToken`; the POC default just requires a token's presence.
      if (!(await enrollAuthorized(body, config))) {
        return httpError(401, 'enroll requires an authenticated session', 'unauthenticated');
      }
      store.enroll(body.installId, body.platform, body.channel, body.devicePublicKeyB64);
      log?.info(`enrolled install ${body.installId} (${body.platform}/${body.channel})`);
      return json({ ok: true });
    },
  });

  // --- client: check for update ----------------------------------------
  routes.push({
    method: 'POST',
    path: '/ota/v1/check',
    handler: (ctx) => {
      const auth = authenticate(ctx, store, config);
      if (isError(auth)) return auth;
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

      const nativePolicy = store.resolveNativePolicy(device.channel, device.buildNumber);
      const release = store.pickEligible(device);
      if (!release) {
        const resp: CheckResponse = { update: null, serverNonce: store.issueServerNonce(auth.installId, ''), nativePolicy };
        return json(resp);
      }
      const resp: CheckResponse = {
        update: release.signedManifest,
        downloadToken: store.issueDownloadToken(release.bundleId),
        serverNonce: store.issueServerNonce(auth.installId, release.bundleId),
        nativePolicy,
      };
      return json(resp);
    },
  });

  // --- client: download ciphertext (one-time token, no S3 URL) ----------
  routes.push({
    method: 'GET',
    path: '/ota/v1/download',
    handler: (ctx) => {
      const token = header(ctx, OTA_HEADERS.downloadToken) ?? ctx.query.get('token') ?? '';
      const bundleId = store.consumeDownloadToken(token);
      if (!bundleId) return httpError(403, 'invalid or used download token', 'bad_token');
      const ciphertext = store.readCiphertext(bundleId);
      if (!ciphertext) return httpError(404, 'ciphertext missing', 'not_found');
      return binary(ciphertext);
    },
  });

  // --- client: confirm apply result ------------------------------------
  routes.push({
    method: 'POST',
    path: '/ota/v1/confirm',
    handler: (ctx) => {
      const auth = authenticate(ctx, store, config);
      if (isError(auth)) return auth;
      const body = ctx.json<ConfirmRequest>();
      if (!body?.bundleId || !body.status) return httpError(400, 'invalid confirm body');
      if (!store.consumeServerNonce(body.serverNonce, auth.installId)) {
        return httpError(401, 'invalid server nonce', 'bad_nonce');
      }
      const autoPaused = store.recordConfirm(body.bundleId, body.status);
      config.onConfirm?.({ installId: auth.installId, bundleId: body.bundleId, status: body.status, reason: body.reason, autoPaused });
      return json({ ok: true, autoPaused });
    },
  });

  // --- admin / CLI: register a trusted public key -----------------------
  routes.push({
    method: 'POST',
    path: '/admin/keys',
    handler: (ctx) => {
      const denied = requireAdmin(ctx, config);
      if (denied) return denied;
      const body = ctx.json<{ keyId: string; publicKeyRawB64: string }>();
      if (!body?.keyId || !body.publicKeyRawB64) return httpError(400, 'keyId and publicKeyRawB64 required');
      store.registerKey(body.keyId, body.publicKeyRawB64);
      log?.info(`registered signing key ${body.keyId}`);
      return json({ ok: true });
    },
  });

  // --- admin / CLI: publish a pre-signed release ------------------------
  routes.push({
    method: 'POST',
    path: '/admin/publish',
    handler: (ctx) => {
      const denied = requireAdmin(ctx, config);
      if (denied) return denied;
      const body = ctx.json<{ signedManifest: SignedManifest; ciphertextB64: string; rolloutPercentage?: number }>();
      if (!body?.signedManifest || !body.ciphertextB64) return httpError(400, 'signedManifest and ciphertextB64 required');

      const { signedManifest } = body;
      const rawKey = store.getTrustedKey(signedManifest.keyId);
      if (!rawKey) return httpError(400, `unknown signing keyId ${signedManifest.keyId}`, 'unknown_key');
      if (!verifyManifest(signedManifest, publicKeyFromRawB64(rawKey))) {
        return httpError(400, 'manifest signature does not verify', 'bad_signature');
      }
      const ciphertext = Buffer.from(body.ciphertextB64, 'base64');
      const ciphertextSha = sha256Hex(ciphertext);
      if (ciphertextSha !== signedManifest.manifest.encryption.ciphertextSha256) {
        return httpError(400, 'ciphertext hash does not match manifest', 'hash_mismatch');
      }
      const record = store.addRelease(signedManifest, ciphertext, Math.max(0, Math.min(100, body.rolloutPercentage ?? 100)));
      config.onPublish?.({
        bundleId: record.bundleId,
        platform: record.platform,
        channel: record.channel,
        bundleVersion: record.bundleVersion,
        runtimeVersion: record.runtimeVersion,
        rolloutPercentage: record.rolloutPercentage,
      });
      log?.info(`published ${record.bundleId} (${record.platform}/${record.channel} v${record.bundleVersion} @ ${record.rolloutPercentage}%)`);
      return json({ ok: true, bundleId: record.bundleId, rolloutPercentage: record.rolloutPercentage });
    },
  });

  // --- admin / console: operate rollouts --------------------------------
  routes.push({
    method: 'GET',
    path: '/admin/releases',
    handler: (ctx) => {
      const denied = requireAdmin(ctx, config);
      if (denied) return denied;
      return json({
        releases: store.listReleases().map((r) => ({
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
        })),
      });
    },
  });

  routes.push({
    method: 'POST',
    path: '/admin/rollout',
    handler: (ctx) => {
      const denied = requireAdmin(ctx, config);
      if (denied) return denied;
      const body = ctx.json<{ bundleId: string; rolloutPercentage: number }>();
      return store.setRollout(body.bundleId, body.rolloutPercentage) ? json({ ok: true }) : httpError(404, 'release not found');
    },
  });

  routes.push({
    method: 'POST',
    path: '/admin/pause',
    handler: (ctx) => {
      const denied = requireAdmin(ctx, config);
      if (denied) return denied;
      const body = ctx.json<{ bundleId: string; paused: boolean }>();
      return store.setPaused(body.bundleId, body.paused) ? json({ ok: true }) : httpError(404, 'release not found');
    },
  });

  routes.push({
    method: 'POST',
    path: '/admin/rollback',
    handler: (ctx) => {
      const denied = requireAdmin(ctx, config);
      if (denied) return denied;
      const body = ctx.json<{ bundleId: string }>();
      return store.rollback(body.bundleId) ? json({ ok: true }) : httpError(404, 'release not found');
    },
  });

  routes.push({
    method: 'POST',
    path: '/admin/native-policy',
    handler: (ctx) => {
      const denied = requireAdmin(ctx, config);
      if (denied) return denied;
      const body = ctx.json<{ channel: string; minSupportedNativeVersion: number; severity: 'soft' | 'hard'; storeUrl?: string }>();
      if (!body?.channel) return httpError(400, 'channel required');
      store.setNativePolicy(body.channel, {
        minSupportedNativeVersion: body.minSupportedNativeVersion,
        severity: body.severity,
        storeUrl: body.storeUrl,
      });
      return json({ ok: true });
    },
  });

  return routes;
}
