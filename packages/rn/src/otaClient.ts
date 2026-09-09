/**
 * The OTA HTTP client: enroll, check, and confirm. Small JSON calls only — the heavy,
 * trust-critical bundle download + verify + decrypt is done natively via
 * {@link downloadAndStage}. Each request is signed **natively** with the device's
 * non-exportable hardware key (ECDSA-P256; no crypto in JS); the canonical signing string
 * matches the backend exactly.
 */

import { Platform } from 'react-native';
import DashOta from './NativeDashOta';
import { STORAGE_KEYS, type OtaConfig } from './config';
import type { CheckResponse, OtaLogger } from './types';

/**
 * Wire protocol this client speaks. Sent on `/check` so a backend can recognise — and retire —
 * clients it no longer serves. Kept local rather than imported: this package ships to apps and
 * must not drag in the server-side toolchain.
 */
export const OTA_PROTOCOL = 2;

const OTA_HEADERS = {
  installId: 'x-ota-install',
  nonce: 'x-ota-nonce',
  timestamp: 'x-ota-timestamp',
  signature: 'x-ota-signature',
} as const;

let nonceCounter = 0;

/**
 * A request nonce, preferring the native CSPRNG ({@link DashOta.generateNonce}) and falling back to
 * a JS construction only if the native method is unavailable (e.g. an older native binary). The
 * native path is the real anti-replay guarantee; the fallback keeps enroll/check working rather
 * than hard-failing on a version skew.
 * @internal exported for tests
 */
export function makeNonce(): string {
  try {
    const native = DashOta.generateNonce();
    if (native) return native;
  } catch {
    // native generateNonce not available on this binary — use the JS fallback below.
  }
  nonceCounter += 1;
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${nonceCounter}`;
}

/**
 * Build the canonical request-signing string — must match `@dash-ota/shared`'s `requestSigningString`.
 * @internal exported for the CLI↔native round-trip guard test
 */
export function signingString(
  method: string,
  path: string,
  installId: string,
  nonce: string,
  timestamp: string,
  bodySha256: string,
): string {
  return [method.toUpperCase(), path, installId, nonce, timestamp, bodySha256].join('\n');
}

/** Resolve (and persist) a stable install id. */
async function getInstallId(config: OtaConfig): Promise<string> {
  const existing = await config.storage.getItem(STORAGE_KEYS.installId);
  if (existing) return existing;
  const id = `inst_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  await config.storage.setItem(STORAGE_KEYS.installId, id);
  return id;
}

/** The resolved client context for a session. */
export interface OtaClientContext {
  serverUrl: string;
  channel: string;
  runtimeVersion: string;
  buildNumber: number;
  installId: string;
  fetchImpl: typeof fetch;
  logger: OtaLogger;
  /** Force a re-enroll (clears the once-marker): key rotation, or the server forgot this install. */
  reenroll: () => Promise<void>;
}

/**
 * Enroll the device's hardware public key — but only when needed. After a successful enroll we
 * persist a marker (`sha256(installId + devicePublicKey)`) and skip re-POSTing `/enroll` on
 * subsequent launches, because enrollment attaches a device-attestation token (Play Integrity /
 * App Attest) whose live round-trip costs quota. `force` re-enrolls regardless — used on key
 * rotation or when the server returns `not_enrolled`. There is **no shared secret**: requests are
 * signed with the device's hardware private key, so nothing sensitive is transmitted at enrollment.
 */
async function enrollIfNeeded(config: OtaConfig, ctx: OtaClientContext, force: boolean): Promise<void> {
  const devicePublicKeyB64 = DashOta.getDevicePublicKeyB64();
  const marker = DashOta.sha256Hex(`${ctx.installId}:${devicePublicKeyB64}`);
  if (!force) {
    const stored = await config.storage.getItem(STORAGE_KEYS.enrolled);
    if (stored === marker) return; // already enrolled with this install + key → skip (saves quota)
  }
  // Report whether the signing key is hardware-backed (StrongBox/TEE/Secure Enclave), so the
  // backend can gate on genuine hardware. Guarded for older native binaries without the method.
  let keyHardwareBacked: boolean | undefined;
  try {
    keyHardwareBacked = DashOta.isDeviceKeyHardwareBacked();
  } catch {
    keyHardwareBacked = undefined;
  }
  const enrollToken = (await config.getEnrollToken?.()) ?? undefined;
  // Device/app integrity attestation (Play Integrity / App Attest), attached at enrollment so the
  // backend's verifyEnrollToken hook can gate registration on a genuine device. Null when the host
  // wires no attestor (the default) — the field is simply omitted.
  const attestationToken = (await config.attestor?.getAttestationToken()) ?? undefined;
  const res = await ctx.fetchImpl(`${ctx.serverUrl}/ota/v2/enroll`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      installId: ctx.installId,
      platform: Platform.OS,
      channel: ctx.channel,
      appVersion: config.appVersion,
      buildNumber: ctx.buildNumber,
      devicePublicKeyB64,
      enrollToken,
      attestationToken,
      keyHardwareBacked,
    }),
  });
  if (!res.ok) throw new Error(`enroll failed: ${res.status}`);
  await config.storage.setItem(STORAGE_KEYS.enrolled, marker);
  ctx.logger.info('enrolled device key');
}

/**
 * Build a signed-request client context, enrolling the device's hardware public key on first use
 * (or on key rotation). Enrollment is idempotent and skipped when already done — see
 * {@link enrollIfNeeded} — so cold starts don't re-attest.
 */
export async function createClientContext(config: OtaConfig, logger: OtaLogger): Promise<OtaClientContext> {
  const ctx: OtaClientContext = {
    serverUrl: config.serverUrlOverride ?? DashOta.getServerUrl(),
    channel: DashOta.getChannel(),
    runtimeVersion: DashOta.getRuntimeVersion(),
    buildNumber: DashOta.getNativeBuildNumber(),
    installId: await getInstallId(config),
    fetchImpl: config.transport?.fetch ?? fetch,
    logger,
    reenroll: async () => {},
  };
  ctx.reenroll = () => enrollIfNeeded(config, ctx, true);
  await enrollIfNeeded(config, ctx, false);
  return ctx;
}

/** POST a JSON request signed with the device's hardware key (ECDSA). */
async function signedPost<T>(ctx: OtaClientContext, path: string, body: unknown, retried = false): Promise<T> {
  const raw = JSON.stringify(body);
  const nonce = makeNonce();
  const timestamp = String(Date.now());
  const bodySha256 = DashOta.sha256Hex(raw);
  const signature = DashOta.signWithDeviceKey(signingString('POST', path, ctx.installId, nonce, timestamp, bodySha256));
  const res = await ctx.fetchImpl(`${ctx.serverUrl}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [OTA_HEADERS.installId]: ctx.installId,
      [OTA_HEADERS.nonce]: nonce,
      [OTA_HEADERS.timestamp]: timestamp,
      [OTA_HEADERS.signature]: signature,
    },
    body: raw,
  });
  if (!res.ok) {
    // The server can forget an install (DB reset / pruning) → `not_enrolled`. Because we enroll
    // once and cache the marker, recover by re-enrolling a single time and retrying the request.
    if (res.status === 401 && !retried) {
      // Defensive: a non-JSON body (or a minimal Response) must not crash the client here.
      let code: string | undefined;
      try {
        code = (JSON.parse(await res.text()) as { code?: string }).code;
      } catch {
        code = undefined;
      }
      if (code === 'not_enrolled') {
        ctx.logger.warn(`${path}: not_enrolled — re-enrolling and retrying`);
        await ctx.reenroll();
        return signedPost<T>(ctx, path, body, true);
      }
    }
    throw new Error(`${path} failed: ${res.status}`);
  }
  return (await res.json()) as T;
}

/** Ask the backend for an eligible update for this device. */
export async function checkForUpdate(
  ctx: OtaClientContext,
  currentBundleVersion: number,
  appVersion: string,
  current: { bundleId: string; bundleSha256: string } = { bundleId: '', bundleSha256: '' },
): Promise<CheckResponse> {
  return signedPost<CheckResponse>(ctx, '/ota/v2/check', {
    installId: ctx.installId,
    platform: Platform.OS,
    channel: ctx.channel,
    runtimeVersion: ctx.runtimeVersion,
    appVersion,
    buildNumber: ctx.buildNumber,
    currentBundleVersion,
    protocol: OTA_PROTOCOL,
    // What the device already holds. The server needs both to decide whether it can offer a
    // bytecode delta instead of the whole bundle; empty strings mean the embedded bundle.
    currentBundleId: current.bundleId,
    currentBundleSha256: current.bundleSha256,
  });
}

/** Report an apply result (drives adoption + server-side auto-pause). */
export async function confirm(
  ctx: OtaClientContext,
  bundleId: string,
  status: 'applied' | 'healthy' | 'failed' | 'rolled_back',
  serverNonce: string,
  reason?: string,
): Promise<void> {
  await signedPost(ctx, '/ota/v2/confirm', {
    installId: ctx.installId,
    bundleId,
    runtimeVersion: ctx.runtimeVersion,
    status,
    serverNonce,
    reason,
  });
}

/**
 * Base URL for this release's blobs. Native appends `/{blobSha256}` per blob it needs.
 *
 * @param ctx - client context.
 * @param bundleId - the release being fetched.
 * @returns the blob base URL.
 */
export function blobBaseUrl(ctx: OtaClientContext, bundleId: string): string {
  return `${ctx.serverUrl}/ota/v2/releases/${encodeURIComponent(bundleId)}/blobs`;
}
