/**
 * The OTA HTTP client: enroll, check, and confirm. Small JSON calls only — the heavy,
 * trust-critical bundle download + verify + decrypt is done natively via
 * {@link downloadAndStage}. Requests are signed with the per-install HMAC secret using the
 * **native** HMAC (no node:crypto in JS); the canonical signing string matches the backend
 * exactly.
 */

import { Platform } from 'react-native';
import DashOta from './NativeDashOta';
import { STORAGE_KEYS, type OtaConfig } from './config';
import type { CheckResponse, OtaLogger } from './types';

const OTA_HEADERS = {
  installId: 'x-ota-install',
  nonce: 'x-ota-nonce',
  timestamp: 'x-ota-timestamp',
  signature: 'x-ota-signature',
} as const;

let nonceCounter = 0;

/** Generate a unique-enough request nonce (POC; a CSPRNG via native is preferable in prod). */
function makeNonce(): string {
  nonceCounter += 1;
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${nonceCounter}`;
}

/** Build the canonical request-signing string — must match `@dash-ota/shared`'s `requestSigningString`. */
function signingString(method: string, path: string, installId: string, nonce: string, timestamp: string, bodySha256: string): string {
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
}

/**
 * Register the device's hardware public key and build a signed-request client context. There
 * is **no shared secret** — requests are signed with the device's hardware private key, so
 * nothing sensitive is transmitted at enrollment.
 */
export async function createClientContext(config: OtaConfig, logger: OtaLogger): Promise<OtaClientContext> {
  const serverUrl = config.serverUrlOverride ?? DashOta.getServerUrl();
  const channel = DashOta.getChannel();
  const runtimeVersion = DashOta.getRuntimeVersion();
  const buildNumber = DashOta.getNativeBuildNumber();
  const installId = await getInstallId(config);
  const fetchImpl = config.transport?.fetch ?? fetch;

  // Register (or re-register, for key rotation) the device's hardware public key, gated by an
  // authenticated session token. The private key never leaves the device.
  const devicePublicKeyB64 = DashOta.getDevicePublicKeyB64();
  const enrollToken = (await config.getEnrollToken?.()) ?? undefined;
  const res = await fetchImpl(`${serverUrl}/ota/v1/enroll`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ installId, platform: Platform.OS, channel, appVersion: config.appVersion, buildNumber, devicePublicKeyB64, enrollToken }),
  });
  if (!res.ok) throw new Error(`enroll failed: ${res.status}`);
  logger.info('enrolled device key');

  return { serverUrl, channel, runtimeVersion, buildNumber, installId, fetchImpl, logger };
}

/** POST a JSON request signed with the device's hardware key (ECDSA). */
async function signedPost<T>(ctx: OtaClientContext, path: string, body: unknown): Promise<T> {
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
  if (!res.ok) throw new Error(`${path} failed: ${res.status}`);
  return (await res.json()) as T;
}

/** Ask the backend for an eligible update for this device. */
export async function checkForUpdate(ctx: OtaClientContext, currentBundleVersion: number, appVersion: string): Promise<CheckResponse> {
  return signedPost<CheckResponse>(ctx, '/ota/v1/check', {
    installId: ctx.installId,
    platform: Platform.OS,
    channel: ctx.channel,
    runtimeVersion: ctx.runtimeVersion,
    appVersion,
    buildNumber: ctx.buildNumber,
    currentBundleVersion,
  });
}

/** Report an apply result (drives adoption + server-side auto-pause). */
export async function confirm(
  ctx: OtaClientContext,
  bundleId: string,
  status: 'applied' | 'healthy' | 'failed' | 'rolled_back',
  serverNonce: string,
  reason?: string
): Promise<void> {
  await signedPost(ctx, '/ota/v1/confirm', { installId: ctx.installId, bundleId, runtimeVersion: ctx.runtimeVersion, status, serverNonce, reason });
}

/** The URL the native side downloads ciphertext from (no S3 URL on the JS side). */
export function downloadUrl(ctx: OtaClientContext): string {
  return `${ctx.serverUrl}/ota/v1/download`;
}
