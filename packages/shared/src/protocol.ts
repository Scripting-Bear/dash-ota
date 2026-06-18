/**
 * Wire protocol types shared by the RN client and the backend. All API communication is
 * JSON over HTTPS; the client signs requests with its per-install HMAC secret (issued at
 * enroll) and echoes a server-issued nonce for anti-replay.
 *
 * @module protocol
 */

import type { Channel, Platform, SignedManifest } from './manifest.js';

/** Header names for per-install request signing / anti-replay. */
export const OTA_HEADERS = {
  installId: 'x-ota-install',
  nonce: 'x-ota-nonce',
  timestamp: 'x-ota-timestamp',
  signature: 'x-ota-signature',
  downloadToken: 'x-ota-download-token',
} as const;

/** Severity of a native-version policy returned by `/check`. */
export type NativePolicySeverity = 'none' | 'soft' | 'hard';

/** Tells the app whether the installed binary is too old and must be updated from the store. */
export interface NativeVersionPolicy {
  /** minimum native build number still supported for this channel. */
  minSupportedNativeVersion: number;
  /** none = fine; soft = dismissible nudge; hard = blocking "update from store" gate. */
  severity: NativePolicySeverity;
  /** optional store URL/deep-link to send the user to. */
  storeUrl?: string;
}

/**
 * POST /ota/v1/enroll — registers the device's **public** key (called once). No secret is
 * issued or transmitted — the device keeps its hardware private key — so there is nothing to
 * intercept at enrollment. `enrollToken` should carry the app's authenticated session so the
 * registration is tied to a real user (the backend validates it).
 */
export interface EnrollRequest {
  installId: string;
  platform: Platform;
  channel: Channel;
  appVersion: string;
  buildNumber: number;
  /** SPKI-DER base64 of the device's hardware EC P-256 public key. */
  devicePublicKeyB64: string;
  /** app session token proving an authenticated user. */
  enrollToken?: string;
}
export interface EnrollResponse {
  ok: true;
}

/** POST /ota/v1/check — the update query. */
export interface CheckRequest {
  installId: string;
  platform: Platform;
  channel: Channel;
  runtimeVersion: string;
  appVersion: string;
  buildNumber: number;
  /** version of the currently-applied bundle (0 = embedded). */
  currentBundleVersion: number;
}

/** POST /ota/v1/check response. */
export interface CheckResponse {
  /** the eligible signed manifest, or null for "no update". */
  update: SignedManifest | null;
  /** one-time, short-TTL token to fetch the ciphertext from /download (no S3 URL exposed). */
  downloadToken?: string;
  /** server-issued nonce the client echoes on /confirm to prove liveness (anti-replay). */
  serverNonce: string;
  /** native-version policy driving the force-update gate. */
  nativePolicy: NativeVersionPolicy;
}

/** Status reported back after an apply attempt. */
export type ConfirmStatus = 'applied' | 'healthy' | 'failed' | 'rolled_back';

/** POST /ota/v1/confirm — adoption + health telemetry that drives server-side auto-pause. */
export interface ConfirmRequest {
  installId: string;
  bundleId: string;
  runtimeVersion: string;
  status: ConfirmStatus;
  /** echo of the serverNonce from the matching /check (liveness). */
  serverNonce: string;
  /** optional failure reason (no PII / no secrets). */
  reason?: string;
}
export interface ConfirmResponse {
  ok: true;
}

/** Standard error body. */
export interface ErrorResponse {
  error: string;
  code?: string;
}
