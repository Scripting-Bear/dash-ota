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
  /** device/app integrity attestation token the client attached, for `verifyEnrollToken` to check. */
  attestationToken?: string;
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
  /**
   * Secret the CLI presents to publish/admin endpoints, compared in constant time. **Empty
   * disables all admin endpoints (fail-closed)** — set it via `OTA_ADMIN_TOKEN` or the
   * `adminToken` option. Never commit it, and serve `/admin/*` only over TLS.
   */
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
  /** hard cap (bytes) on a published ciphertext — rejects oversized bundles at ingest (abuse / memory guard). */
  maxBundleBytes: number;
  /** max `/enroll` requests per install per {@link rateLimitWindowMs} window; `0` disables. */
  enrollRateLimit: number;
  /** max `/check` requests per authenticated install per {@link rateLimitWindowMs} window; `0` disables. */
  checkRateLimit: number;
  /** fixed rate-limit window in ms, shared by `/enroll` + `/check`. */
  rateLimitWindowMs: number;
  /** require a valid device-key signature on /check + /confirm (POC can disable for quick tests). */
  requireRequestSignature: boolean;
  /** require an authenticated session token (enrollToken) on /enroll. */
  requireEnrollAuth: boolean;
  /**
   * One-line upgrade to a shared cache: a Redis connection string (or `OTA_REDIS_URL`). When set
   * — and no explicit `cache` provider is passed — the backend wires the Redis {@link CacheProvider}
   * for correct multi-instance anti-replay + rate-limiting. Requires the optional `ioredis` peer.
   */
  redisUrl?: string;
  /**
   * One-line upgrade to a durable database: a Postgres connection string (or `OTA_DATABASE_URL`).
   * When set — and no explicit `db` provider is passed — the backend wires the Postgres
   * {@link DatabaseProvider} (ACID, concurrency-safe) instead of the Disk default. Requires the
   * optional `pg` peer; the schema is created automatically on first use.
   */
  databaseUrl?: string;
  /**
   * One-line upgrade to a durable single-file store: a SQLite file path (or `OTA_SQLITE_PATH`).
   * When set — and neither an explicit `db` provider nor {@link databaseUrl} is given — the backend
   * wires the SQLite {@link DatabaseProvider} (ACID, no server). Requires the optional native
   * `better-sqlite3` peer; the file + schema are created on first use.
   */
  sqlitePath?: string;
  /**
   * One-line upgrade to object storage: an S3-compatible bucket name (or `OTA_S3_BUCKET`). When set
   * — and no explicit `blob` provider is passed — the backend stores ciphertext in S3/R2/MinIO
   * instead of on disk. Requires the optional `@aws-sdk/client-s3` peer. Pair with
   * {@link s3Endpoint} + {@link s3ForcePathStyle} for R2/MinIO; credentials use the AWS env chain.
   */
  s3Bucket?: string;
  /** region for the S3 blob store (or `OTA_S3_REGION`). */
  s3Region?: string;
  /** custom endpoint for the S3 blob store, e.g. an R2/MinIO URL (or `OTA_S3_ENDPOINT`). */
  s3Endpoint?: string;
  /** path-style addressing for the S3 blob store — needed by MinIO / some R2 setups (or `OTA_S3_FORCE_PATH_STYLE=true`). */
  s3ForcePathStyle?: boolean;
  /** key prefix inside the bucket for the S3 blob store, e.g. `bundles/` (or `OTA_S3_PREFIX`). */
  s3Prefix?: string;
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
    adminToken: process.env.OTA_ADMIN_TOKEN ?? '',
    storageDir: process.env.OTA_STORAGE_DIR ?? join(pkgRoot, 'storage'),
    dataDir: process.env.OTA_DATA_DIR ?? join(pkgRoot, '.data'),
    timestampSkewMs: envNum('OTA_TS_SKEW_MS', 5 * 60 * 1000),
    downloadTokenTtlMs: envNum('OTA_DL_TTL_MS', 2 * 60 * 1000),
    nonceTtlMs: envNum('OTA_NONCE_TTL_MS', 10 * 60 * 1000),
    autoPauseFailureRate: envNum('OTA_AUTOPAUSE_RATE', 0.2),
    autoPauseMinSamples: envNum('OTA_AUTOPAUSE_MIN', 5),
    maxBundleBytes: envNum('OTA_MAX_BUNDLE_BYTES', 100 * 1024 * 1024),
    enrollRateLimit: envNum('OTA_ENROLL_RATE', 10),
    checkRateLimit: envNum('OTA_CHECK_RATE', 60),
    rateLimitWindowMs: envNum('OTA_RATE_WINDOW_MS', 60 * 1000),
    requireRequestSignature: process.env.OTA_REQUIRE_SIG !== 'false',
    requireEnrollAuth: process.env.OTA_REQUIRE_ENROLL_AUTH !== 'false',
    redisUrl: process.env.OTA_REDIS_URL,
    databaseUrl: process.env.OTA_DATABASE_URL,
    sqlitePath: process.env.OTA_SQLITE_PATH,
    s3Bucket: process.env.OTA_S3_BUCKET,
    s3Region: process.env.OTA_S3_REGION,
    s3Endpoint: process.env.OTA_S3_ENDPOINT,
    s3ForcePathStyle: process.env.OTA_S3_FORCE_PATH_STYLE === 'true',
    s3Prefix: process.env.OTA_S3_PREFIX,
  };
}

/** Options accepted by the library entry points — a partial config plus bring-your-own storage. */
export type OtaBackendOptions = Partial<BackendConfig> & {
  /**
   * Provide a pre-constructed (or custom-backed) {@link import('./store.js').Store}. When
   * omitted, a Store is created from `providers` (or the disk/in-memory defaults).
   */
  store?: import('./store.js').Store;
  /**
   * Swap in your own persistence without subclassing the Store: supply any of
   * `{ db, blob, cache }` (Postgres / Redis / S3 adapters). Ignored if `store` is given.
   */
  providers?: Partial<import('./providers.js').StoreProviders>;
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
  const { store: _store, providers: _providers, ...overrides } = options;
  return { ...loadConfig(), ...overrides };
}
