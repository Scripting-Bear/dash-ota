/**
 * The backend's persistence + lookup layer — a thin, storage-agnostic facade over three
 * pluggable providers ({@link DatabaseProvider} + {@link BlobStore} + {@link CacheProvider}).
 * The Store holds the OTA **business logic** (targeting/rollout eligibility, adoption
 * accounting + server-side auto-pause, one-time token / server-nonce minting); it delegates
 * all storage to the providers, so swapping in Postgres + Redis + object storage never touches
 * this class or the route core.
 *
 * The default providers are a zero-dependency single-node implementation (disk + in-memory).
 * Bring your own by passing `{ db, blob, cache }` to the constructor.
 *
 * @module store
 */

import {
  collectBlobShas,
  type ConfirmStatus,
  type DeviceContext,
  findBlobEntry,
  isEligible,
  MANIFEST_SCHEMA,
  type ManifestV2,
  totalBlobBytes,
  type NativeVersionPolicy,
  type SignedManifest,
  rolloutBucket,
  randomSecretB64,
  sha256Hex,
} from '@dash-ota/shared';
import type { Readable } from 'node:stream';
import { PostgresDatabaseProvider } from './adapters/postgres-db.js';
import { RedisCacheProvider } from './adapters/redis-cache.js';
import { createReadStream } from 'node:fs';
import { S3BlobStore } from './adapters/s3-blob.js';
import { BlobTooLargeError, drain, type SpooledBlob, spoolToTemp } from './upload.js';
import { SqliteDatabaseProvider } from './adapters/sqlite-db.js';
import type { BackendConfig } from './config.js';
import {
  type BlobStore,
  blobKey,
  type ByteRange,
  type CacheProvider,
  type DatabaseProvider,
  DiskBlobStore,
  DiskDatabaseProvider,
  MemoryCacheProvider,
  type RateLimitResult,
  releasePrefix,
  type ReleaseRecord,
  type StoreProviders,
} from './providers.js';

/** A refusal a route can turn straight into a response. */
export interface StoreFailure {
  ok: false;
  status: number;
  code: string;
  error: string;
  missing?: string[];
}

export type { AdoptionStats, ReleaseRecord, InstallRecord } from './providers.js';
export type { BlobStore, CacheProvider, DatabaseProvider, RateLimitResult, StoreProviders } from './providers.js';
export { DiskBlobStore, DiskDatabaseProvider, MemoryCacheProvider } from './providers.js';

/**
 * The persistence + lookup layer. Composes a {@link DatabaseProvider} (durable metadata), a
 * {@link BlobStore} (ciphertext), and a {@link CacheProvider} (ephemeral single-use state).
 */
export class Store {
  private readonly db: DatabaseProvider;
  private readonly blob: BlobStore;
  private readonly cache: CacheProvider;

  /**
   * @param config resolved backend config (TTLs, auto-pause thresholds, default dirs)
   * @param providers optional overrides — supply any of `{ db, blob, cache }` to swap in your
   *   own infrastructure; each defaults to the zero-dependency disk / in-memory implementation.
   */
  constructor(
    private readonly config: BackendConfig,
    providers?: Partial<StoreProviders>,
  ) {
    // DB: explicit provider wins; else Postgres (`databaseUrl`); else SQLite (`sqlitePath`); else disk JSON.
    this.db =
      providers?.db ??
      (config.databaseUrl
        ? new PostgresDatabaseProvider({ url: config.databaseUrl })
        : config.sqlitePath
          ? new SqliteDatabaseProvider({ path: config.sqlitePath })
          : new DiskDatabaseProvider(config.dataDir));
    // Blob: explicit provider wins; else the one-line `s3Bucket` upgrade; else local disk.
    this.blob =
      providers?.blob ??
      (config.s3Bucket
        ? new S3BlobStore({
            bucket: config.s3Bucket,
            region: config.s3Region,
            endpoint: config.s3Endpoint,
            forcePathStyle: config.s3ForcePathStyle,
            prefix: config.s3Prefix,
          })
        : new DiskBlobStore(config.storageDir));
    // Cache: explicit provider wins; else the one-line `redisUrl` upgrade; else in-memory (single node).
    this.cache =
      providers?.cache ?? (config.redisUrl ? new RedisCacheProvider({ url: config.redisUrl }) : new MemoryCacheProvider());
  }

  // ---- trusted signing keys ---------------------------------------------

  /** Register a trusted signing public key (raw base64). The backend never holds the private key. */
  async registerKey(keyId: string, publicKeyRawB64: string): Promise<void> {
    await this.db.putTrustedKey(keyId, publicKeyRawB64);
  }

  /** Look up a trusted public key by id. */
  async getTrustedKey(keyId: string): Promise<string | undefined> {
    return (await this.db.getTrustedKey(keyId)) ?? undefined;
  }

  // ---- native-version policy (force-update gate) ------------------------

  /** Set the force-update policy for a channel (severity is what applies when too old). */
  async setNativePolicy(channel: string, policy: NativeVersionPolicy): Promise<void> {
    await this.db.putNativePolicy(channel, policy);
  }

  /**
   * Resolve the native policy for a device. Returns severity `none` when the device meets the
   * minimum, otherwise the configured severity (soft nudge / hard gate).
   * @param channel the device channel
   * @param buildNumber the device's native build number
   */
  async resolveNativePolicy(channel: string, buildNumber: number): Promise<NativeVersionPolicy> {
    const cfg = await this.db.getNativePolicy(channel);
    if (!cfg) return { minSupportedNativeVersion: 0, severity: 'none' };
    const severity = buildNumber < cfg.minSupportedNativeVersion ? cfg.severity : 'none';
    return { ...cfg, severity };
  }

  // ---- installs ----------------------------------------------------------

  /** Register (or re-register, e.g. on key rotation) an install's device public key. */
  async enroll(installId: string, platform: string, channel: string, devicePublicKeyB64: string): Promise<void> {
    await this.db.putInstall({ installId, devicePublicKeyB64, platform, channel, createdAt: new Date().toISOString() });
  }

  /** Look up an install's device public key, if enrolled. */
  async getDevicePublicKey(installId: string): Promise<string | undefined> {
    return (await this.db.getInstall(installId))?.devicePublicKeyB64;
  }

  // ---- releases ----------------------------------------------------------

  /** Store a published release: ciphertext to the blob store, metadata to the database. */
  /** One release by id, or null. */
  async getRelease(bundleId: string): Promise<ReleaseRecord | null> {
    return this.db.getRelease(bundleId);
  }

  /** Every release, newest first. */
  async listReleases(): Promise<ReleaseRecord[]> {
    return (await this.db.listReleases()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /**
   * Step one of publishing: record the release and report which blobs are still missing.
   *
   * The release is stored unfinalised, so it cannot be served until every blob has arrived. That is
   * what makes publishing resumable — re-running the CLI after a failure re-reports only the gap.
   *
   * @param signedManifest - the signed manifest; the caller has already verified its signature.
   * @param rolloutPercentage - initial rollout.
   * @returns the record plus the blob hashes still to upload.
   */
  async createRelease(
    signedManifest: SignedManifest,
    rolloutPercentage: number,
  ): Promise<{ record: ReleaseRecord; missing: string[] }> {
    const m = signedManifest.manifest;
    const existing = await this.db.getRelease(m.bundleId);
    const record: ReleaseRecord = {
      bundleId: m.bundleId,
      platform: m.platform,
      channel: m.channel,
      runtimeVersion: m.runtimeVersion,
      bundleVersion: m.bundleVersion,
      signedManifest,
      rolloutPercentage,
      paused: existing?.paused ?? false,
      rolledBack: existing?.rolledBack ?? false,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      adoption: existing?.adoption ?? { applied: 0, healthy: 0, failed: 0, rolled_back: 0 },
      schema: m.schema,
      finalized: false,
      totalBytes: totalBlobBytes(m),
    };
    await this.db.putRelease(record);
    return { record, missing: await this.missingBlobs(m) };
  }

  /**
   * @param manifest - a release manifest.
   * @returns the hashes of blobs the store does not yet hold at the right size.
   */
  async missingBlobs(manifest: ManifestV2): Promise<string[]> {
    const missing: string[] = [];
    for (const sha of collectBlobShas(manifest)) {
      const expected = findBlobEntry(manifest, sha);
      const stat = await this.blob.stat(blobKey(manifest.bundleId, sha));
      if (!stat || stat.size !== expected?.size) missing.push(sha);
    }
    return missing;
  }

  /**
   * Step two: store one blob, streamed and hash-checked against the manifest.
   *
   * Idempotent — re-uploading a blob that is already correct is a no-op, so a resumed publish
   * costs nothing for what already landed.
   *
   * @param bundleId - the release.
   * @param blobSha256 - the hash the caller claims these bytes have.
   * @param body - the request body.
   * @param maxBytes - hard cap; the body is drained and rejected past it.
   */
  async stageBlob(
    bundleId: string,
    blobSha256: string,
    body: Readable,
    maxBytes: number,
  ): Promise<{ ok: true; already: boolean } | StoreFailure> {
    const record = await this.db.getRelease(bundleId);
    if (!record) return { ok: false, status: 404, code: 'no_release', error: 'unknown bundleId' };
    const expected = findBlobEntry(record.signedManifest.manifest, blobSha256);
    if (!expected) {
      return { ok: false, status: 404, code: 'no_blob', error: 'this release does not reference that blob' };
    }

    const key = blobKey(bundleId, blobSha256);
    const existing = await this.blob.stat(key);
    if (existing && existing.size === expected.size) {
      await drain(body);
      return { ok: true, already: true };
    }

    let spooled: SpooledBlob;
    try {
      spooled = await spoolToTemp(body, maxBytes);
    } catch (err) {
      if (err instanceof BlobTooLargeError) {
        return { ok: false, status: 413, code: 'too_large', error: `blob exceeds ${err.limit} bytes` };
      }
      throw err;
    }
    try {
      // The hash is what the manifest signed, so a mismatch means these are not the bytes the
      // publisher signed — refuse rather than store something no device will accept.
      if (spooled.sha256 !== blobSha256) {
        return { ok: false, status: 400, code: 'hash_mismatch', error: 'body does not hash to the blob id' };
      }
      if (spooled.size !== expected.size) {
        return { ok: false, status: 400, code: 'size_mismatch', error: `expected ${expected.size} bytes, got ${spooled.size}` };
      }
      await this.blob.put(key, createReadStream(spooled.path));
      return { ok: true, already: false };
    } finally {
      spooled.dispose();
    }
  }

  /**
   * Step three: make the release servable, once every blob is present.
   *
   * @param bundleId - the release.
   * @returns the finalised record, or the missing blobs.
   */
  async finalizeRelease(bundleId: string): Promise<{ ok: true; record: ReleaseRecord; already: boolean } | StoreFailure> {
    const record = await this.db.getRelease(bundleId);
    if (!record) return { ok: false, status: 404, code: 'no_release', error: 'unknown bundleId' };
    if (record.finalized) return { ok: true, record, already: true };

    const missing = await this.missingBlobs(record.signedManifest.manifest);
    if (missing.length > 0) {
      return { ok: false, status: 409, code: 'incomplete', error: 'blobs are still missing', missing };
    }
    const finalized: ReleaseRecord = { ...record, finalized: true };
    await this.db.putRelease(finalized);
    return { ok: true, record: finalized, already: false };
  }

  /** Discard an unfinalised release and every blob it uploaded. */
  async discardRelease(bundleId: string): Promise<void> {
    await this.blob.deletePrefix(releasePrefix(bundleId));
  }

  /** Size of one blob, for `Content-Length` and range validation. */
  async statBlob(bundleId: string, blobSha256: string): Promise<{ size: number } | null> {
    return this.blob.stat(blobKey(bundleId, blobSha256));
  }

  /** Streaming reader over one blob, optionally ranged for resume. */
  async openBlobStream(bundleId: string, blobSha256: string, range?: ByteRange): Promise<Readable | null> {
    return this.blob.openReadStream(blobKey(bundleId, blobSha256), range);
  }

  /** Set a release's rollout percentage. @returns false when the release is unknown. */
  async setRollout(bundleId: string, pct: number): Promise<boolean> {
    const r = await this.db.getRelease(bundleId);
    if (!r) return false;
    r.rolloutPercentage = Math.max(0, Math.min(100, Math.round(pct)));
    await this.db.putRelease(r);
    return true;
  }

  /** Pause or resume a release — the kill switch. @returns false when the release is unknown. */
  async setPaused(bundleId: string, paused: boolean): Promise<boolean> {
    const r = await this.db.getRelease(bundleId);
    if (!r) return false;
    r.paused = paused;
    await this.db.putRelease(r);
    return true;
  }

  /** Withdraw a release permanently. @returns false when the release is unknown. */
  async rollback(bundleId: string): Promise<boolean> {
    const r = await this.db.getRelease(bundleId);
    if (!r) return false;
    r.rolledBack = true;
    r.paused = true;
    await this.db.putRelease(r);
    return true;
  }

  /** Count a request from a client too old to speak protocol 2. */
  async recordRetiredClient(channel: string, platform: string): Promise<void> {
    await this.db.incrementRetiredClient(channel, platform);
  }

  /** Retired-client hits, keyed `"<channel>/<platform>"`. */
  async getRetiredClients(): Promise<Record<string, number>> {
    return this.db.getRetiredClients();
  }

  /**
   * The policy handed to a retired client: whatever the channel says, forced to `hard`. A client
   * that cannot speak the protocol cannot be helped by an OTA, only by a store update.
   */
  async retiredPolicy(channel: string): Promise<NativeVersionPolicy> {
    const cfg = await this.db.getNativePolicy(channel);
    return {
      minSupportedNativeVersion: cfg?.minSupportedNativeVersion ?? 0,
      severity: 'hard',
      ...(cfg?.storeUrl ? { storeUrl: cfg.storeUrl } : {}),
    };
  }

  /**
   * Pick the best eligible release for a device: finalized, schema 2, matching
   * runtimeVersion/channel/platform, newer than current, inside the rollout bucket, not paused or
   * rolled back. Highest bundleVersion wins. The cross-generation guarantee is enforced here.
   *
   * @param device - the reporting device context.
   * @returns the chosen release, or null for "no update".
   */
  async pickEligible(device: DeviceContext): Promise<ReleaseRecord | null> {
    const candidates = (await this.listReleases()).filter((r) => {
      // A half-published release must never reach a device, and this backend only serves schema 2.
      if (!r.finalized || r.schema !== MANIFEST_SCHEMA) return false;
      if (r.paused || r.rolledBack) return false;
      if (!isEligible(r.signedManifest.manifest, device).eligible) return false;
      return rolloutBucket(device.installId, r.bundleId) < r.rolloutPercentage;
    });
    if (candidates.length === 0) return null;
    return candidates.reduce((best, r) => (r.bundleVersion > best.bundleVersion ? r : best));
  }

  // ---- anti-replay: client nonces ---------------------------------------

  /**
   * Record a client request nonce; resolves false if it was already seen (replay).
   * @param nonce the client-supplied nonce
   * @returns true if fresh, false if replayed
   */
  async registerNonce(nonce: string): Promise<boolean> {
    return this.cache.registerNonce(nonce, this.config.nonceTtlMs);
  }

  // ---- rate limiting -----------------------------------------------------

  /**
   * Fixed-window rate-limit check for a `scope` + `identity`. A `limit <= 0` disables the check
   * (always allowed). Keys are namespaced per scope so `/enroll` and `/check` budgets are separate.
   * @param scope the endpoint bucket (e.g. `enroll`, `check`)
   * @param identity the install/principal the limit applies to
   * @param limit max requests per window (`<= 0` disables)
   * @param windowMs the fixed window length
   */
  async rateLimit(scope: string, identity: string, limit: number, windowMs: number): Promise<RateLimitResult> {
    if (limit <= 0) return { allowed: true, remaining: Number.MAX_SAFE_INTEGER, resetMs: 0 };
    return this.cache.rateLimit(`rl:${scope}:${identity}`, limit, windowMs);
  }

  // ---- one-time download tokens -----------------------------------------

  /** Issue a one-time, short-TTL token bound to a bundle. */
  async issueDownloadToken(bundleId: string, installId: string): Promise<string> {
    const token = randomSecretB64(24);
    await this.cache.putToken(token, `${bundleId}|${installId}`, this.config.downloadTokenTtlMs);
    return token;
  }

  /**
   * Read a download token without spending it. Reusable within its TTL because one update is many
   * blob requests, and a resumed download is many more.
   *
   * @param token - the token from the `x-ota-download-token` header.
   * @returns which release and install it authorises, or null.
   */
  async peekDownloadToken(token: string): Promise<{ bundleId: string; installId: string } | null> {
    const value = await this.cache.peekToken(token);
    if (!value) return null;
    const [bundleId, installId] = value.split('|');
    return bundleId && installId ? { bundleId, installId } : null;
  }

  /** Consume a download token; returns the bundleId once, then never again. */


  // ---- server nonces (bind /confirm to a real /check) -------------------

  /**
   * Issue a server nonce returned from /check and echoed on /confirm, bound to **both** the install
   * and the offered bundle — so a device can only confirm the bundle it was actually offered (an
   * arbitrary-bundle confirm can't poison adoption or trip a targeted rollout's auto-pause).
   * An up-to-date check offers no bundle and passes `''`, which binds the nonce to the install only.
   */
  async issueServerNonce(installId: string, bundleId: string): Promise<string> {
    const nonce = randomSecretB64(18);
    await this.cache.putToken(nonce, JSON.stringify({ installId, bundleId }), this.config.nonceTtlMs);
    return nonce;
  }

  /**
   * Consume a server nonce, asserting it was issued to this install for this bundle.
   *
   * A nonce issued by an **up-to-date** check carries no bundle binding (`''`), but the device still
   * confirms with the bundle it is actually running — that is how a `healthy` report arrives, since
   * the launch that runs a bundle to healthy is by definition the launch with nothing newer to
   * fetch. Requiring an exact match there rejected every healthy confirm (401 `bad_nonce`), so
   * adoption's `healthy` counter could never leave 0. An install-only binding is therefore accepted
   * as a wildcard over that install's own bundles; a bundle-bound nonce still has to match exactly.
   */
  async consumeServerNonce(nonce: string, installId: string, bundleId: string): Promise<boolean> {
    const value = await this.cache.consumeToken(nonce);
    if (value === null) return false;
    try {
      const parsed = JSON.parse(value) as { installId: string; bundleId: string };
      if (parsed.installId !== installId) return false;
      return parsed.bundleId === '' || parsed.bundleId === bundleId;
    } catch {
      return false;
    }
  }

  // ---- adoption + auto-pause --------------------------------------------

  /**
   * Record a confirm event and auto-pause the rollout if the failure rate is too high.
   * @param bundleId the release
   * @param status the reported status
   * @returns whether this confirm triggered an auto-pause
   */
  async recordConfirm(bundleId: string, status: ConfirmStatus): Promise<boolean> {
    const r = await this.db.getRelease(bundleId);
    if (!r) return false;
    r.adoption[status] += 1;
    const total = r.adoption.applied + r.adoption.healthy + r.adoption.failed + r.adoption.rolled_back;
    const failures = r.adoption.failed + r.adoption.rolled_back;
    let autoPaused = false;
    if (!r.paused && total >= this.config.autoPauseMinSamples && failures / total >= this.config.autoPauseFailureRate) {
      r.paused = true;
      autoPaused = true;
    }
    await this.db.putRelease(r);
    return autoPaused;
  }

  /** Hash a request body for signature checks (helper kept here for locality). */
  static bodyHash(raw: Buffer): string {
    return sha256Hex(raw);
  }
}
