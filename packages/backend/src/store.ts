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
  type ConfirmStatus,
  type DeviceContext,
  isEligible,
  type NativeVersionPolicy,
  type SignedManifest,
  rolloutBucket,
  randomSecretB64,
  sha256Hex,
} from '@dash-ota/shared';
import type { BackendConfig } from './config.js';
import {
  type BlobStore,
  type CacheProvider,
  type DatabaseProvider,
  DiskBlobStore,
  DiskDatabaseProvider,
  MemoryCacheProvider,
  type ReleaseRecord,
  type StoreProviders,
} from './providers.js';

export type { AdoptionStats, ReleaseRecord, InstallRecord } from './providers.js';
export type { BlobStore, CacheProvider, DatabaseProvider, StoreProviders } from './providers.js';
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
    this.db = providers?.db ?? new DiskDatabaseProvider(config.dataDir);
    this.blob = providers?.blob ?? new DiskBlobStore(config.storageDir);
    this.cache = providers?.cache ?? new MemoryCacheProvider();
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
  async addRelease(signedManifest: SignedManifest, ciphertext: Buffer, rolloutPercentage: number): Promise<ReleaseRecord> {
    const m = signedManifest.manifest;
    await this.blob.put(m.bundleId, ciphertext);
    const record: ReleaseRecord = {
      bundleId: m.bundleId,
      platform: m.platform,
      channel: m.channel,
      runtimeVersion: m.runtimeVersion,
      bundleVersion: m.bundleVersion,
      signedManifest,
      rolloutPercentage,
      paused: false,
      rolledBack: false,
      createdAt: new Date().toISOString(),
      adoption: { applied: 0, healthy: 0, failed: 0, rolled_back: 0 },
    };
    await this.db.putRelease(record);
    return record;
  }

  /** List all releases (newest first). */
  async listReleases(): Promise<ReleaseRecord[]> {
    return (await this.db.listReleases()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async getRelease(bundleId: string): Promise<ReleaseRecord | undefined> {
    return (await this.db.getRelease(bundleId)) ?? undefined;
  }

  async setRollout(bundleId: string, pct: number): Promise<boolean> {
    const r = await this.db.getRelease(bundleId);
    if (!r) return false;
    r.rolloutPercentage = Math.max(0, Math.min(100, Math.round(pct)));
    await this.db.putRelease(r);
    return true;
  }

  async setPaused(bundleId: string, paused: boolean): Promise<boolean> {
    const r = await this.db.getRelease(bundleId);
    if (!r) return false;
    r.paused = paused;
    await this.db.putRelease(r);
    return true;
  }

  async rollback(bundleId: string): Promise<boolean> {
    const r = await this.db.getRelease(bundleId);
    if (!r) return false;
    r.rolledBack = true;
    r.paused = true;
    await this.db.putRelease(r);
    return true;
  }

  /** Read the ciphertext bytes for a bundle (from the blob store). */
  async readCiphertext(bundleId: string): Promise<Buffer | null> {
    return this.blob.get(bundleId);
  }

  /**
   * Pick the best eligible release for a device: matches runtimeVersion/channel/platform,
   * newer than current, within the rollout bucket, not paused/rolled-back — highest
   * bundleVersion wins. This is where the cross-generation guarantee is enforced server-side.
   * @param device the reporting device context
   * @returns the chosen release or null for "no update"
   */
  async pickEligible(device: DeviceContext): Promise<ReleaseRecord | null> {
    const candidates = (await this.listReleases()).filter((r) => {
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

  // ---- one-time download tokens -----------------------------------------

  /** Issue a one-time, short-TTL token bound to a bundle. */
  async issueDownloadToken(bundleId: string): Promise<string> {
    const token = randomSecretB64(24);
    await this.cache.putToken(token, bundleId, this.config.downloadTokenTtlMs);
    return token;
  }

  /** Consume a download token; returns the bundleId once, then never again. */
  async consumeDownloadToken(token: string): Promise<string | null> {
    return this.cache.consumeToken(token);
  }

  // ---- server nonces (bind /confirm to a real /check) -------------------

  /** Issue a server nonce returned from /check and echoed on /confirm (bound to the install). */
  async issueServerNonce(installId: string, _bundleId: string): Promise<string> {
    const nonce = randomSecretB64(18);
    await this.cache.putToken(nonce, installId, this.config.nonceTtlMs);
    return nonce;
  }

  /** Consume a server nonce, asserting it was the one issued to this install. */
  async consumeServerNonce(nonce: string, installId: string): Promise<boolean> {
    const value = await this.cache.consumeToken(nonce);
    return value !== null && value === installId;
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
