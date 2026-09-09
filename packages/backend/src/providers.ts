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

import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
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
  /** Manifest schema of this release; only schema 2 is servable. */
  schema: number;
  /**
   * False until every blob the manifest references has been uploaded. Unfinalised releases are
   * invisible to `pickEligible`, so a half-published release can never be handed to a device.
   */
  finalized: boolean;
  /** Stored bytes across every distinct blob, for the admin listing. */
  totalBytes: number;
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

  /**
   * Count a request from a client too old to speak the current protocol. The only signal that a
   * retired population still exists, so an operator can see who is stranded on an old binary.
   */
  incrementRetiredClient(channel: string, platform: string): Promise<void>;
  /** Retired-client hits, keyed `"<channel>/<platform>"`. */
  getRetiredClients(): Promise<Record<string, number>>;
}

/** The encrypted bundle byte store, keyed by `bundleId`. */
/** Inclusive byte range, as parsed from a `Range` header. */
export interface ByteRange {
  start: number;
  end: number;
}

/**
 * Content-addressed blob storage. Keys are `releases/{bundleId}/{blobSha256}`, so a blob is
 * immutable and safe to cache forever; a release's blobs share a prefix so deleting one is a
 * single prefix sweep.
 */
export interface BlobStore {
  /** Store bytes at `key`. Accepts a stream so a large blob never has to be buffered whole. */
  put(key: string, data: Buffer | Readable): Promise<void>;
  /** The stored bytes, or `null` if absent. Prefer {@link openReadStream} to serve downloads. */
  get(key: string): Promise<Buffer | null>;
  /** Byte length of the stored blob, or `null` if absent (drives `Content-Length`). */
  stat(key: string): Promise<{ size: number } | null>;
  /** Streaming reader, optionally over an inclusive byte range for resume. `null` if absent. */
  openReadStream(key: string, range?: ByteRange): Promise<Readable | null>;
  /** Remove one blob. */
  delete(key: string): Promise<void>;
  /** Remove every blob under a key prefix — used to drop an abandoned release. */
  deletePrefix(prefix: string): Promise<void>;
}

/**
 * The storage key for one blob.
 *
 * @param bundleId - the release it belongs to.
 * @param blobSha256 - hash of the stored bytes.
 * @returns the blob store key.
 */
export function blobKey(bundleId: string, blobSha256: string): string {
  return `releases/${bundleId}/${blobSha256}`;
}

/** The prefix covering every blob of one release. */
export function releasePrefix(bundleId: string): string {
  return `releases/${bundleId}/`;
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
  /** Store a token → value with a TTL. */
  putToken(token: string, value: string, ttlMs: number): Promise<void>;
  /** Atomically consume a single-use token, returning its value exactly once (else `null`). */
  consumeToken(token: string): Promise<string | null>;
  /**
   * Read a token without consuming it. A v2 update is many blob requests and a resumed download is
   * many more, so the download token is reusable within its TTL rather than one-shot.
   */
  peekToken(token: string): Promise<string | null>;
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
  private readonly retiredClients = new Map<string, number>();
  private readonly releasesFile: string;
  private readonly installsFile: string;
  private readonly keysFile: string;
  private readonly policiesFile: string;
  private readonly retiredFile: string;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.releasesFile = join(dataDir, 'releases.json');
    this.installsFile = join(dataDir, 'installs.json');
    this.keysFile = join(dataDir, 'trusted-keys.json');
    this.policiesFile = join(dataDir, 'native-policies.json');
    this.retiredFile = join(dataDir, 'retired-clients.json');
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
    if (existsSync(this.retiredFile))
      for (const [k, v] of Object.entries(JSON.parse(readFileSync(this.retiredFile, 'utf8')) as Record<string, number>))
        this.retiredClients.set(k, v);
  }

  async incrementRetiredClient(channel: string, platform: string): Promise<void> {
    const key = `${channel}/${platform}`;
    this.retiredClients.set(key, (this.retiredClients.get(key) ?? 0) + 1);
    writeFileSync(this.retiredFile, JSON.stringify(Object.fromEntries(this.retiredClients)));
  }

  async getRetiredClients(): Promise<Record<string, number>> {
    return Object.fromEntries(this.retiredClients);
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

  /** Keys contain `/`, so they map onto nested directories; the key is validated by the caller. */
  private path(key: string): string {
    return join(this.dir, ...key.split('/'));
  }

  async put(key: string, data: Buffer | Readable): Promise<void> {
    const p = this.path(key);
    mkdirSync(dirname(p), { recursive: true });
    // Write beside the target and rename, so a crashed publish never leaves a short blob that
    // would then hash-mismatch on every device that fetched it.
    const tmp = `${p}.tmp`;
    if (Buffer.isBuffer(data)) writeFileSync(tmp, data);
    else await pipeline(data, createWriteStream(tmp));
    renameSync(tmp, p);
  }

  async get(key: string): Promise<Buffer | null> {
    const p = this.path(key);
    return existsSync(p) ? readFileSync(p) : null;
  }

  async stat(key: string): Promise<{ size: number } | null> {
    const p = this.path(key);
    return existsSync(p) ? { size: statSync(p).size } : null;
  }

  async openReadStream(key: string, range?: ByteRange): Promise<Readable | null> {
    const p = this.path(key);
    if (!existsSync(p)) return null;
    return range ? createReadStream(p, { start: range.start, end: range.end }) : createReadStream(p);
  }

  async delete(key: string): Promise<void> {
    rmSync(this.path(key), { force: true });
  }

  async deletePrefix(prefix: string): Promise<void> {
    rmSync(this.path(prefix), { recursive: true, force: true });
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

  async peekToken(token: string): Promise<string | null> {
    this.sweep();
    return this.tokens.get(token)?.value ?? null;
  }

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
