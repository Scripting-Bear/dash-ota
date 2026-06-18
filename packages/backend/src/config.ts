/**
 * Backend configuration. POC defaults are env-overridable; nothing here is a secret except
 * `ADMIN_TOKEN` (the CLI's publish/admin credential) — and crucially **not** the signing
 * private key, which the backend never has.
 *
 * @module config
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ConfirmStatus } from '@dash-ota/shared';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..');

/** Minimal logger the backend emits through (defaults to `console`). */
export interface OtaBackendLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/** Identity presented at `/enroll`, passed to {@link BackendHooks.verifyEnrollToken}. */
export interface EnrollPrincipal {
  installId: string;
  platform: string;
  channel: string;
  appVersion?: string;
  buildNumber?: number;
}

/** A `/confirm` outcome, surfaced to {@link BackendHooks.onConfirm} for analytics. */
export interface ConfirmEvent {
  installId: string;
  bundleId: string;
  status: ConfirmStatus;
  reason?: string;
  /** whether this confirm tripped the server-side auto-pause. */
  autoPaused: boolean;
}

/** A publish, surfaced to {@link BackendHooks.onPublish}. */
export interface PublishEvent {
  bundleId: string;
  platform: string;
  channel: string;
  bundleVersion: number;
  runtimeVersion: string;
  rolloutPercentage: number;
}

/**
 * Pluggable, config-driven extension points. All optional — the package works with none of
 * them — but they are how a host app wires its own auth, analytics, and logging without
 * forking the core.
 */
export interface BackendHooks {
  /** sink for the backend's own logs (default: `console`). */
  logger?: OtaBackendLogger;
  /**
   * Validate the enroll session token against your auth service. Return `true` to allow the
   * device to register its key. If omitted, the POC falls back to `requireEnrollAuth`
   * (presence-only) checking.
   */
  verifyEnrollToken?: (token: string | undefined, principal: EnrollPrincipal) => boolean | Promise<boolean>;
  /** called after every `/confirm` (adoption/health telemetry, alerting). */
  onConfirm?: (event: ConfirmEvent) => void;
  /** called after every successful `/admin/publish`. */
  onPublish?: (event: PublishEvent) => void;
}

/** Resolved backend configuration. */
export interface BackendConfig extends BackendHooks {
  port: number;
  /** shared secret the CLI presents to publish/admin endpoints. */
  adminToken: string;
  /** directory where encrypted bundle archives are stored. */
  storageDir: string;
  /** directory for persisted release/install metadata. */
  dataDir: string;
  /** allowed clock skew for request timestamps (ms). */
  timestampSkewMs: number;
  /** TTL for one-time download tokens (ms). */
  downloadTokenTtlMs: number;
  /** TTL for replay-protection nonce cache (ms). */
  nonceTtlMs: number;
  /** failure rate (0..1) at which a rollout auto-pauses. */
  autoPauseFailureRate: number;
  /** minimum confirm samples before auto-pause can trigger. */
  autoPauseMinSamples: number;
  /** require a valid device-key signature on /check + /confirm (POC can disable for quick tests). */
  requireRequestSignature: boolean;
  /** require an authenticated session token (enrollToken) on /enroll. */
  requireEnrollAuth: boolean;
}

/** Read a number env var with a fallback. */
function envNum(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** Load configuration from the environment with safe POC defaults. */
export function loadConfig(): BackendConfig {
  return {
    port: envNum('OTA_PORT', 4455),
    adminToken: process.env.OTA_ADMIN_TOKEN ?? 'dev-admin-token',
    storageDir: process.env.OTA_STORAGE_DIR ?? join(pkgRoot, 'storage'),
    dataDir: process.env.OTA_DATA_DIR ?? join(pkgRoot, '.data'),
    timestampSkewMs: envNum('OTA_TS_SKEW_MS', 5 * 60 * 1000),
    downloadTokenTtlMs: envNum('OTA_DL_TTL_MS', 2 * 60 * 1000),
    nonceTtlMs: envNum('OTA_NONCE_TTL_MS', 10 * 60 * 1000),
    autoPauseFailureRate: envNum('OTA_AUTOPAUSE_RATE', 0.2),
    autoPauseMinSamples: envNum('OTA_AUTOPAUSE_MIN', 5),
    requireRequestSignature: process.env.OTA_REQUIRE_SIG !== 'false',
    requireEnrollAuth: process.env.OTA_REQUIRE_ENROLL_AUTH !== 'false',
  };
}

/** Options accepted by the library entry points — a partial config plus a bring-your-own store. */
export type OtaBackendOptions = Partial<BackendConfig> & {
  /**
   * Provide a pre-constructed (or custom-backed) {@link import('./store.js').Store}. When
   * omitted, a disk-backed store is created from `storageDir`/`dataDir`.
   */
  store?: import('./store.js').Store;
};

/**
 * Resolve a complete {@link BackendConfig} by layering caller-supplied options over the
 * env/POC defaults. This is what makes the package config-driven: a host passes only the
 * fields it cares about (e.g. `adminToken`, `verifyEnrollToken`) and inherits safe defaults
 * for the rest.
 *
 * @param options partial overrides (security params, dirs, hooks)
 * @returns a fully-resolved backend config
 */
export function resolveBackendConfig(options: OtaBackendOptions = {}): BackendConfig {
  const { store: _store, ...overrides } = options;
  return { ...loadConfig(), ...overrides };
}
