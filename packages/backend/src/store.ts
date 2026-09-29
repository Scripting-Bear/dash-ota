/**
 * The backend's persistence + lookup layer — a thin, storage-agnostic facade over three
 * pluggable providers ({@link DatabaseProvider} + {@link BlobStore} + {@link CacheProvider}).
 * The Store holds the OTA **business logic** (targeting/rollout eligibility, adoption
 * accounting + server-side auto-pause, download-token / server-nonce minting); it delegates
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
import { resolve, sep } from 'node:path';
import type { Readable } from 'node:stream';
import { PostgresDatabaseProvider } from './adapters/postgres-db.js';
import { RedisCacheProvider } from './adapters/redis-cache.js';
import { createReadStream } from 'node:fs';
import { S3BlobStore } from './adapters/s3-blob.js';
import { BlobTooLargeError, drain, type SpooledBlob, spoolToTemp } from './upload.js';
import { SqliteDatabaseProvider } from './adapters/sqlite-db.js';
import type { BackendConfig } from './config.js';
import {
  type AdoptionStats,
  type BlobStore,
  blobKey,
  type ByteRange,
  type CacheProvider,
  type DatabaseProvider,
  DiskBlobStore,
  DiskDatabaseProvider,
  MemoryCacheProvider,
  type RateLimitResult,
  type ReleaseRecord,
  type StoreProviders,
} from './providers.js';

/** Channel names accepted from callers, including unauthenticated ones. */
const CHANNEL_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

/** Whether `value` is a channel name the backend will store or look up. */
export function isValidChannel(value: unknown): value is string {
  return typeof value === 'string' && CHANNEL_PATTERN.test(value);
}

/** Whether `value` is a platform a release can target. */
export function isValidPlatform(value: unknown): value is 'android' | 'ios' {
  return value === 'android' || value === 'ios';
}

/** Schemes an app-store link may use. The client enforces the same list before opening one. */
const STORE_URL_PROTOCOLS = new Set(['https:', 'market:', 'itms-apps:']);

/**
 * Whether `value` is a store link the app may open: an allowed scheme, no userinfo, and no
 * whitespace or control characters. The host is not checked, so any https page passes.
 */
export function isValidStoreUrl(value: unknown): value is string {
  if (typeof value !== 'string' || /\s/.test(value) || [...value].some(isControlChar)) return false;
  if (!/^[a-z-]+:\/\//.test(value)) return false;
  try {
    const url = new URL(value);
    return STORE_URL_PROTOCOLS.has(url.protocol) && url.username === '' && url.password === '';
  } catch {
    return false;
  }
}

/** C0 and C1 control characters, which `new URL` would silently strip or percent-encode. */
function isControlChar(ch: string): boolean {
  const code = ch.charCodeAt(0);
  return code < 0x20 || (code >= 0x7f && code <= 0x9f);
}

/** A stored policy with a storeUrl that fails {@link isValidStoreUrl} dropped; older versions stored any string. */
function withSafeStoreUrl(policy: NativeVersionPolicy): NativeVersionPolicy {
  if (policy.storeUrl === undefined || isValidStoreUrl(policy.storeUrl)) return policy;
  const { storeUrl: _dropped, ...rest } = policy;
  return rest;
}

/**
 * Refuse a disk directory inside `node_modules`: npm deletes it on the next install or upgrade.
 *
 * @throws when `dir` resolves inside a `node_modules` directory.
 */
function assertOutsideNodeModules(name: string, dir: string): void {
  const absolute = resolve(dir);
  if (absolute.split(sep).includes('node_modules')) {
    throw new Error(
      `dash-ota: ${name} resolves inside node_modules (${absolute}), which npm deletes on install or upgrade. ` +
        `Set ${name} (or its OTA_* environment variable) to a directory outside node_modules.`,
    );
  }
}

/**
 * Prefix for keys the backend itself registers through {@link CacheProvider.registerNonce}. No header
 * value can contain a newline, so no client request nonce can collide with them.
 */
const INTERNAL_KEY = '\n';

/** How long an install's failure report for a bundle is remembered, so it is counted once. */
const FAILURE_DEDUPE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * What a `/check` made a server nonce valid for. Channel, platform and the current bundle are
 * device-reported, so this scopes a nonce; it does not prove the device runs that bundle.
 */
export interface ConfirmScope {
  /** the bundle offered and the bundle the device reported running; empty ids are ignored. */
  bundleIds: string[];
  platform: string;
  channel: string;
  runtimeVersion: string;
  currentBundleVersion: number;
}

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
    const diskDb = !providers?.db && !config.databaseUrl && !config.sqlitePath;
    const diskBlob = !providers?.blob && !config.s3Bucket;
    if (diskDb) assertOutsideNodeModules('dataDir', config.dataDir);
    if (diskBlob) assertOutsideNodeModules('storageDir', config.storageDir);
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
    if (diskDb) config.logger?.info(`metadata directory: ${resolve(config.dataDir)}`);
    if (diskBlob) config.logger?.info(`blob directory: ${resolve(config.storageDir)}`);
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
    return withSafeStoreUrl({ ...cfg, severity });
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
   * @returns the record plus the blob hashes still to upload, or a refusal.
   */
  async createRelease(
    signedManifest: SignedManifest,
    rolloutPercentage: number,
  ): Promise<{ ok: true; record: ReleaseRecord; missing: string[] } | StoreFailure> {
    const m = signedManifest.manifest;
    const existing = await this.db.getRelease(m.bundleId);

    // A published release is immutable. Its manifest is signed and devices may already be running
    // it, so replacing it under the same id would change what a given bundleId means — exactly the
    // ambiguity signing exists to prevent.
    if (existing?.finalized) {
      return {
        ok: false,
        status: 409,
        code: 'already_published',
        error: `${m.bundleId} is already published; publish a new bundleVersion instead`,
      };
    }
    // An unfinalised attempt is fair game to replace. Keep every blob the new manifest still
    // references — with a stable channel content key an unchanged file seals to the same blob, so
    // these are exactly the bytes an interrupted publish already uploaded. Dropping them would
    // turn every retry into a full re-upload.
    if (existing) await this.discardRelease(m.bundleId, collectBlobShas(m));

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
    return { ok: true, record, missing: await this.missingBlobs(m) };
  }

  /**
   * @param manifest - a release manifest.
   * @returns the hashes of blobs the store does not yet hold at the right size.
   */
  async missingBlobs(manifest: ManifestV2): Promise<string[]> {
    const missing: string[] = [];
    for (const sha of collectBlobShas(manifest)) {
      const expected = findBlobEntry(manifest, sha);
      const stat = await this.blob.stat(blobKey(sha));
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

    const key = blobKey(blobSha256);
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

  /**
   * Blob hashes referenced by any release except `exceptBundleId`.
   *
   * Derived from the release records on every call rather than kept as a counter. A refcount is
   * one bug away from deleting a blob a live release still needs, and the release table is the
   * only thing that actually knows the truth. Unfinalised releases count too: a publish in flight
   * may already reference a blob another release uploaded.
   *
   * @param exceptBundleId - the release being removed.
   * @returns the set of blob hashes that must survive.
   */
  private async blobsReferencedElsewhere(exceptBundleId: string): Promise<Set<string>> {
    const keep = new Set<string>();
    for (const other of await this.db.listReleases()) {
      if (other.bundleId === exceptBundleId) continue;
      for (const sha of collectBlobShas(other.signedManifest.manifest)) keep.add(sha);
    }
    return keep;
  }

  /**
   * Discard a release, removing only the blobs nothing else needs.
   *
   * @param bundleId - the release to discard.
   * @param keepAlso - blob hashes to spare on top of those other releases reference, used when the
   *   release is being replaced rather than removed: the incoming manifest is not in the store yet,
   *   so it cannot protect its own blobs.
   */
  async discardRelease(bundleId: string, keepAlso: Iterable<string> = []): Promise<void> {
    const record = await this.db.getRelease(bundleId);
    if (!record) return;
    const keep = await this.blobsReferencedElsewhere(bundleId);
    for (const sha of keepAlso) keep.add(sha);
    for (const sha of collectBlobShas(record.signedManifest.manifest)) {
      if (!keep.has(sha)) await this.blob.delete(blobKey(sha));
    }
  }

  /**
   * Size of one blob, for `Content-Length` and range validation.
   *
   * The blob namespace is global, so membership is checked here rather than implied by the key:
   * a release may only read blobs its own signed manifest lists.
   */
  async statBlob(bundleId: string, blobSha256: string): Promise<{ size: number } | null> {
    if (!(await this.releaseReferences(bundleId, blobSha256))) return null;
    return this.blob.stat(blobKey(blobSha256));
  }

  /** Streaming reader over one blob, optionally ranged for resume. */
  async openBlobStream(bundleId: string, blobSha256: string, range?: ByteRange): Promise<Readable | null> {
    if (!(await this.releaseReferences(bundleId, blobSha256))) return null;
    return this.blob.openReadStream(blobKey(blobSha256), range);
  }

  /** Whether `bundleId`'s signed manifest lists `blobSha256`. */
  private async releaseReferences(bundleId: string, blobSha256: string): Promise<boolean> {
    const record = await this.db.getRelease(bundleId);
    return !!record && !!findBlobEntry(record.signedManifest.manifest, blobSha256);
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

  /**
   * Count a request from a client too old to speak protocol 2. The caller is unauthenticated, so
   * only a known platform and a well-formed channel are persisted.
   */
  async recordRetiredClient(channel: string, platform: string): Promise<void> {
    if (!isValidChannel(channel) || !isValidPlatform(platform)) return;
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
      ...(cfg && isValidStoreUrl(cfg.storeUrl) ? { storeUrl: cfg.storeUrl } : {}),
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

  // ---- download tokens ---------------------------------------------------

  /** Issue a download token bound to a bundle, reusable until `downloadTokenTtlMs` expires. */
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

  // ---- server nonces (bind /confirm to a real /check) -------------------

  /**
   * Issue the server nonce `/check` returns and `/confirm` echoes, bound to the install and to what
   * that check made relevant (see {@link ConfirmScope}).
   */
  async issueServerNonce(installId: string, scope: ConfirmScope): Promise<string> {
    const nonce = randomSecretB64(18);
    const bundleIds = [...new Set(scope.bundleIds.filter((id) => id !== ''))];
    await this.cache.putToken(nonce, JSON.stringify({ ...scope, installId, bundleIds }), this.config.nonceTtlMs);
    return nonce;
  }

  /**
   * Spend a server nonce on one report, if it covers it: same install, a release on the check's
   * channel and platform, and a bundle that check offered or the device reported running.
   *
   * Spendable once per (bundle, status) pair: clients send every report after a check (`applied`
   * then `healthy`, say) with that check's one nonce.
   *
   * `failed` also covers a newer release on the same runtime. The client reports a crash-loop
   * revert only after reverting, so the failed bundle is no longer current, and a paused or
   * superseded release is no longer offered.
   */
  async consumeServerNonce(nonce: unknown, installId: string, bundleId: string, status: ConfirmStatus): Promise<boolean> {
    if (typeof nonce !== 'string' || nonce === '') return false;
    const value = await this.cache.peekToken(nonce);
    if (value === null) return false;
    let scope: Partial<ConfirmScope> & { installId?: unknown };
    try {
      scope = JSON.parse(value) as typeof scope;
    } catch {
      return false;
    }
    if (scope.installId !== installId || !Array.isArray(scope.bundleIds)) return false;
    const release = await this.db.getRelease(bundleId);
    if (!release || release.platform !== scope.platform || release.channel !== scope.channel) return false;
    const covered =
      scope.bundleIds.includes(bundleId) ||
      (status === 'failed' &&
        release.runtimeVersion === scope.runtimeVersion &&
        release.bundleVersion > Number(scope.currentBundleVersion));
    if (!covered) return false;
    return this.cache.registerNonce(`${INTERNAL_KEY}confirm:${nonce}:${status}:${bundleId}`, this.config.nonceTtlMs);
  }

  // ---- adoption + auto-pause --------------------------------------------

  /**
   * Record a confirm event and auto-pause the rollout if the failure rate is too high.
   * @param bundleId the release
   * @param status the reported status
   * @param installId the reporting install; with it, a second failure report from that install for
   *   this bundle is not counted, so one device cannot drive an auto-pause
   * @returns whether this confirm triggered an auto-pause
   */
  async recordConfirm(bundleId: string, status: ConfirmStatus, installId?: string): Promise<boolean> {
    const r = await this.db.getRelease(bundleId);
    if (!r) return false;
    if (installId && (status === 'failed' || status === 'rolled_back')) {
      const first = await this.cache.registerNonce(`${INTERNAL_KEY}failure:${installId}:${bundleId}`, FAILURE_DEDUPE_TTL_MS);
      if (!first) return false;
    }
    // Rebuilt from the known keys on a null prototype, which also drops keys an older version let in.
    const counts = Object.create(null) as AdoptionStats;
    for (const key of ['applied', 'healthy', 'failed', 'rolled_back'] as const) counts[key] = Number(r.adoption?.[key]) || 0;
    counts[status] += 1;
    r.adoption = counts;
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
