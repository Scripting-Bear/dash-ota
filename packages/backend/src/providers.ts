/**
 * Pluggable persistence providers — the seam that makes the backend "bring your own
 * infrastructure". The {@link Store} composes three async providers and holds no storage
 * logic of its own:
 *
 * - {@link DatabaseProvider} — durable metadata (releases, installs, trusted signing keys,
 *   native-version policies). Map onto Postgres, SQLite, Cloudflare D1, …
 * - {@link BlobStore} — the encrypted bundle bytes. Map onto local disk, S3 / R2 / MinIO, …
 * - {@link CacheProvider} — ephemeral, TTL'd single-use state (client-nonce replay guard,
 *   one-time download tokens, server nonces). Map onto in-memory (single node) or Redis
 *   (multi-instance — required for correct anti-replay across >1 replica).
 *
 * The defaults exported here ({@link DiskDatabaseProvider} + {@link DiskBlobStore} +
 * {@link MemoryCacheProvider}) are a zero-dependency single-node implementation. Everything is
 * `async` so real network-backed adapters (Postgres/Redis/S3) drop in without touching the
 * route core.
 *
 * @module providers
 */

import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import type { NativeVersionPolicy, SignedManifest } from '@dash-ota/shared';

/** Per-release adoption / health counters accumulated from `/confirm`. */
export interface AdoptionStats {
  applied: number;
  healthy: number;
  failed: number;
  rolled_back: number;
}

/** A published release the backend serves (the ciphertext bytes live in the {@link BlobStore}). */
export interface ReleaseRecord {
  bundleId: string;
  platform: string;
  channel: string;
  runtimeVersion: string;
  bundleVersion: number;
  signedManifest: SignedManifest;
  rolloutPercentage: number;
  paused: boolean;
  rolledBack: boolean;
  createdAt: string;
  adoption: AdoptionStats;
}

/** An enrolled install and its hardware device public key (the request-auth identity). */
export interface InstallRecord {
  installId: string;
  /** the device's hardware EC P-256 public key (SPKI-DER, base64). */
  devicePublicKeyB64: string;
  platform: string;
  channel: string;
  createdAt: string;
}

/**
 * Durable metadata store. Implementations must be safe for the backend's read-modify-write
 * pattern (the caller reads a record, mutates it, and calls {@link putRelease}); a production
 * adapter should make those updates atomic (row-level, a transaction, or an atomic UPSERT).
 */
export interface DatabaseProvider {
  getRelease(bundleId: string): Promise<ReleaseRecord | null>;
  /** All releases, order-independent (the {@link Store} sorts newest-first). */
  listReleases(): Promise<ReleaseRecord[]>;
  /** Insert or replace a release by `bundleId`. */
  putRelease(record: ReleaseRecord): Promise<void>;

  getInstall(installId: string): Promise<InstallRecord | null>;
  /** Insert or replace an install by `installId` (re-enroll on key rotation). */
  putInstall(record: InstallRecord): Promise<void>;

  getTrustedKey(keyId: string): Promise<string | null>;
  putTrustedKey(keyId: string, publicKeyRawB64: string): Promise<void>;

  getNativePolicy(channel: string): Promise<NativeVersionPolicy | null>;
  putNativePolicy(channel: string, policy: NativeVersionPolicy): Promise<void>;
}

/** The encrypted bundle byte store, keyed by `bundleId`. */
export interface BlobStore {
  put(bundleId: string, data: Buffer): Promise<void>;
  /** The ciphertext bytes, or `null` if absent. Buffers the whole blob — prefer {@link openReadStream} to serve downloads. */
  get(bundleId: string): Promise<Buffer | null>;
  /** Byte length of the stored blob, or `null` if absent (drives `Content-Length` + the client size pre-check). */
  stat(bundleId: string): Promise<{ size: number } | null>;
  /** Open a streaming reader over the blob, or `null` if absent — the download path never buffers the ciphertext whole. */
  openReadStream(bundleId: string): Promise<Readable | null>;
}

/** The outcome of a {@link CacheProvider.rateLimit} check for one key in the current window. */
export interface RateLimitResult {
  /** whether this request is within the limit. */
  allowed: boolean;
  /** requests still allowed in the current window (never negative). */
  remaining: number;
  /** milliseconds until the current window resets. */
  resetMs: number;
}

/**
 * Ephemeral, TTL'd single-use state. **Must be shared across instances** (e.g. Redis) for the
 * anti-replay, one-time-token, and rate-limit guarantees to hold when running more than one
 * replica; the in-memory default only protects a single process.
 */
export interface CacheProvider {
  /** Record a client nonce; resolve `true` if fresh, `false` if seen within `ttlMs` (replay). */
  registerNonce(nonce: string, ttlMs: number): Promise<boolean>;
  /** Store a single-use token → value with a TTL. */
  putToken(token: string, value: string, ttlMs: number): Promise<void>;
  /** Atomically consume a single-use token, returning its value exactly once (else `null`). */
  consumeToken(token: string): Promise<string | null>;
  /**
   * Fixed-window rate limit: atomically increment the counter for `key` within the current
   * `windowMs` window and report whether it is still within `limit`. Map onto Redis as
   * `INCR` + `PEXPIRE` (first hit sets the TTL) so the window is shared across instances.
   */
  rateLimit(key: string, limit: number, windowMs: number): Promise<RateLimitResult>;
}

/** The three providers the {@link Store} composes. */
export interface StoreProviders {
  db: DatabaseProvider;
  blob: BlobStore;
  cache: CacheProvider;
}

// ---------------------------------------------------------------- defaults

/**
 * Default metadata store: in-memory maps mirrored to pretty-printed JSON files under `dataDir`.
 * Zero-dependency and fine for a single node; swap for Postgres/SQLite in production (this
 * synchronous full-file rewrite is not safe for concurrent writers).
 */
export class DiskDatabaseProvider implements DatabaseProvider {
  private readonly releases = new Map<string, ReleaseRecord>();
  private readonly installs = new Map<string, InstallRecord>();
  private readonly trustedKeys = new Map<string, string>();
  private readonly nativePolicies = new Map<string, NativeVersionPolicy>();
  private readonly releasesFile: string;
  private readonly installsFile: string;
  private readonly keysFile: string;
  private readonly policiesFile: string;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.releasesFile = join(dataDir, 'releases.json');
    this.installsFile = join(dataDir, 'installs.json');
    this.keysFile = join(dataDir, 'trusted-keys.json');
    this.policiesFile = join(dataDir, 'native-policies.json');
    this.load();
  }

  private load(): void {
    if (existsSync(this.releasesFile))
      for (const r of JSON.parse(readFileSync(this.releasesFile, 'utf8')) as ReleaseRecord[]) this.releases.set(r.bundleId, r);
    if (existsSync(this.installsFile))
      for (const i of JSON.parse(readFileSync(this.installsFile, 'utf8')) as InstallRecord[]) this.installs.set(i.installId, i);
    if (existsSync(this.keysFile))
      for (const [k, v] of Object.entries(JSON.parse(readFileSync(this.keysFile, 'utf8')) as Record<string, string>))
        this.trustedKeys.set(k, v);
    if (existsSync(this.policiesFile))
      for (const [k, v] of Object.entries(
        JSON.parse(readFileSync(this.policiesFile, 'utf8')) as Record<string, NativeVersionPolicy>,
      ))
        this.nativePolicies.set(k, v);
  }

  private write(file: string, data: unknown): void {
    writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
  }

  async getRelease(bundleId: string): Promise<ReleaseRecord | null> {
    return this.releases.get(bundleId) ?? null;
  }
  async listReleases(): Promise<ReleaseRecord[]> {
    return [...this.releases.values()];
  }
  async putRelease(record: ReleaseRecord): Promise<void> {
    this.releases.set(record.bundleId, record);
    this.write(this.releasesFile, [...this.releases.values()]);
  }

  async getInstall(installId: string): Promise<InstallRecord | null> {
    return this.installs.get(installId) ?? null;
  }
  async putInstall(record: InstallRecord): Promise<void> {
    this.installs.set(record.installId, record);
    this.write(this.installsFile, [...this.installs.values()]);
  }

  async getTrustedKey(keyId: string): Promise<string | null> {
    return this.trustedKeys.get(keyId) ?? null;
  }
  async putTrustedKey(keyId: string, publicKeyRawB64: string): Promise<void> {
    this.trustedKeys.set(keyId, publicKeyRawB64);
    this.write(this.keysFile, Object.fromEntries(this.trustedKeys));
  }

  async getNativePolicy(channel: string): Promise<NativeVersionPolicy | null> {
    return this.nativePolicies.get(channel) ?? null;
  }
  async putNativePolicy(channel: string, policy: NativeVersionPolicy): Promise<void> {
    this.nativePolicies.set(channel, policy);
    this.write(this.policiesFile, Object.fromEntries(this.nativePolicies));
  }
}

/** Default blob store: one `<bundleId>.bin` file per release under `storageDir`. */
export class DiskBlobStore implements BlobStore {
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }
  private path(bundleId: string): string {
    return join(this.dir, `${bundleId}.bin`);
  }
  async put(bundleId: string, data: Buffer): Promise<void> {
    writeFileSync(this.path(bundleId), data);
  }
  async get(bundleId: string): Promise<Buffer | null> {
    const p = this.path(bundleId);
    return existsSync(p) ? readFileSync(p) : null;
  }
  async stat(bundleId: string): Promise<{ size: number } | null> {
    const p = this.path(bundleId);
    return existsSync(p) ? { size: statSync(p).size } : null;
  }
  async openReadStream(bundleId: string): Promise<Readable | null> {
    const p = this.path(bundleId);
    return existsSync(p) ? createReadStream(p) : null;
  }
}

/**
 * Default cache: in-process maps with lazy TTL sweeping. Single-node only — the replay guard
 * and one-time tokens are per-process, so use a shared {@link CacheProvider} (Redis) when
 * running more than one instance.
 */
export class MemoryCacheProvider implements CacheProvider {
  private readonly nonces = new Map<string, number>();
  private readonly tokens = new Map<string, { value: string; expiresAt: number }>();
  private readonly rateWindows = new Map<string, { count: number; resetAt: number }>();

  async registerNonce(nonce: string, ttlMs: number): Promise<boolean> {
    this.sweep();
    if (this.nonces.has(nonce)) return false;
    this.nonces.set(nonce, Date.now() + ttlMs);
    return true;
  }

  async rateLimit(key: string, limit: number, windowMs: number): Promise<RateLimitResult> {
    const now = Date.now();
    let w = this.rateWindows.get(key);
    if (!w || w.resetAt <= now) {
      w = { count: 0, resetAt: now + windowMs };
      this.rateWindows.set(key, w);
    }
    w.count += 1;
    return { allowed: w.count <= limit, remaining: Math.max(0, limit - w.count), resetMs: w.resetAt - now };
  }

  async putToken(token: string, value: string, ttlMs: number): Promise<void> {
    this.tokens.set(token, { value, expiresAt: Date.now() + ttlMs });
  }

  async consumeToken(token: string): Promise<string | null> {
    const rec = this.tokens.get(token);
    if (!rec) return null;
    this.tokens.delete(token); // one-time
    return rec.expiresAt < Date.now() ? null : rec.value;
  }

  private sweep(): void {
    const now = Date.now();
    for (const [n, exp] of this.nonces) if (exp < now) this.nonces.delete(n);
    for (const [t, rec] of this.tokens) if (rec.expiresAt < now) this.tokens.delete(t);
    for (const [k, w] of this.rateWindows) if (w.resetAt <= now) this.rateWindows.delete(k);
  }
}
