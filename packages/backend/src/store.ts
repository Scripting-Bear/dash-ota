/**
 * In-memory + on-disk store for the POC backend. Holds published **releases** (pre-signed
 * manifest + ciphertext path + rollout state + adoption stats), enrolled **installs** (their
 * HMAC secrets), and ephemeral **nonce / download-token** caches for anti-replay.
 *
 * Swap the disk/in-memory bits for Postgres + Redis + object storage when productionizing;
 * the method surface stays the same.
 *
 * @module store
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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

/** Per-release adoption / health counters from /confirm. */
export interface AdoptionStats {
  applied: number;
  healthy: number;
  failed: number;
  rolled_back: number;
}

/** A published release the backend serves. */
export interface ReleaseRecord {
  bundleId: string;
  platform: string;
  channel: string;
  runtimeVersion: string;
  bundleVersion: number;
  signedManifest: SignedManifest;
  /** absolute path to the encrypted archive on disk. */
  ciphertextPath: string;
  rolloutPercentage: number;
  paused: boolean;
  rolledBack: boolean;
  createdAt: string;
  adoption: AdoptionStats;
}

interface InstallRecord {
  installId: string;
  /** the device's hardware EC P-256 public key (SPKI-DER, base64) — the auth identity. */
  devicePublicKeyB64: string;
  platform: string;
  channel: string;
  createdAt: string;
}

interface ExpiringToken {
  bundleId: string;
  expiresAt: number;
  used: boolean;
}

interface ServerNonceRecord {
  installId: string;
  bundleId: string;
  expiresAt: number;
}

/** The backend's persistence + lookup layer. */
export class Store {
  private readonly releases = new Map<string, ReleaseRecord>();
  private readonly installs = new Map<string, InstallRecord>();
  private readonly seenNonces = new Map<string, number>();
  private readonly downloadTokens = new Map<string, ExpiringToken>();
  private readonly serverNonces = new Map<string, ServerNonceRecord>();
  private readonly trustedKeys = new Map<string, string>();
  private readonly releasesFile: string;
  private readonly installsFile: string;
  private readonly keysFile: string;

  constructor(private readonly config: BackendConfig) {
    mkdirSync(config.storageDir, { recursive: true });
    mkdirSync(config.dataDir, { recursive: true });
    this.releasesFile = join(config.dataDir, 'releases.json');
    this.installsFile = join(config.dataDir, 'installs.json');
    this.keysFile = join(config.dataDir, 'trusted-keys.json');
    this.load();
  }

  /** Load persisted releases + installs + trusted keys from disk (best-effort). */
  private load(): void {
    if (existsSync(this.releasesFile)) {
      const arr = JSON.parse(readFileSync(this.releasesFile, 'utf8')) as ReleaseRecord[];
      for (const r of arr) this.releases.set(r.bundleId, r);
    }
    if (existsSync(this.installsFile)) {
      const arr = JSON.parse(readFileSync(this.installsFile, 'utf8')) as InstallRecord[];
      for (const i of arr) this.installs.set(i.installId, i);
    }
    if (existsSync(this.keysFile)) {
      const obj = JSON.parse(readFileSync(this.keysFile, 'utf8')) as Record<string, string>;
      for (const [k, v] of Object.entries(obj)) this.trustedKeys.set(k, v);
    }
  }

  private persistKeys(): void {
    writeFileSync(this.keysFile, JSON.stringify(Object.fromEntries(this.trustedKeys), null, 2), 'utf8');
  }

  /** Register a trusted signing public key (raw base64). The backend never holds the private key. */
  registerKey(keyId: string, publicKeyRawB64: string): void {
    this.trustedKeys.set(keyId, publicKeyRawB64);
    this.persistKeys();
  }

  /** Look up a trusted public key by id. */
  getTrustedKey(keyId: string): string | undefined {
    return this.trustedKeys.get(keyId);
  }

  // ---- native-version policy (force-update gate) -------------------------

  private readonly nativePolicies = new Map<string, NativeVersionPolicy>();

  /** Set the force-update policy for a channel (severity is what applies when too old). */
  setNativePolicy(channel: string, policy: NativeVersionPolicy): void {
    this.nativePolicies.set(channel, policy);
  }

  /**
   * Resolve the native policy for a device. Returns severity `none` when the device meets
   * the minimum, otherwise the configured severity (soft nudge / hard gate).
   * @param channel the device channel
   * @param buildNumber the device's native build number
   */
  resolveNativePolicy(channel: string, buildNumber: number): NativeVersionPolicy {
    const cfg = this.nativePolicies.get(channel);
    if (!cfg) return { minSupportedNativeVersion: 0, severity: 'none' };
    const severity = buildNumber < cfg.minSupportedNativeVersion ? cfg.severity : 'none';
    return { ...cfg, severity };
  }

  private persistReleases(): void {
    writeFileSync(this.releasesFile, JSON.stringify([...this.releases.values()], null, 2), 'utf8');
  }

  private persistInstalls(): void {
    writeFileSync(this.installsFile, JSON.stringify([...this.installs.values()], null, 2), 'utf8');
  }

  // ---- installs ----------------------------------------------------------

  /** Register (or re-register, e.g. on key rotation) an install's device public key. */
  enroll(installId: string, platform: string, channel: string, devicePublicKeyB64: string): void {
    this.installs.set(installId, {
      installId,
      devicePublicKeyB64,
      platform,
      channel,
      createdAt: new Date().toISOString(),
    });
    this.persistInstalls();
  }

  /** Look up an install's device public key, if enrolled. */
  getDevicePublicKey(installId: string): string | undefined {
    return this.installs.get(installId)?.devicePublicKeyB64;
  }

  // ---- releases ----------------------------------------------------------

  /** Store a published release (pre-signed manifest + ciphertext). */
  addRelease(signedManifest: SignedManifest, ciphertext: Buffer, rolloutPercentage: number): ReleaseRecord {
    const m = signedManifest.manifest;
    const ciphertextPath = join(this.config.storageDir, `${m.bundleId}.bin`);
    writeFileSync(ciphertextPath, ciphertext);
    const record: ReleaseRecord = {
      bundleId: m.bundleId,
      platform: m.platform,
      channel: m.channel,
      runtimeVersion: m.runtimeVersion,
      bundleVersion: m.bundleVersion,
      signedManifest,
      ciphertextPath,
      rolloutPercentage,
      paused: false,
      rolledBack: false,
      createdAt: new Date().toISOString(),
      adoption: { applied: 0, healthy: 0, failed: 0, rolled_back: 0 },
    };
    this.releases.set(m.bundleId, record);
    this.persistReleases();
    return record;
  }

  /** List all releases (newest first). */
  listReleases(): ReleaseRecord[] {
    return [...this.releases.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  getRelease(bundleId: string): ReleaseRecord | undefined {
    return this.releases.get(bundleId);
  }

  setRollout(bundleId: string, pct: number): boolean {
    const r = this.releases.get(bundleId);
    if (!r) return false;
    r.rolloutPercentage = Math.max(0, Math.min(100, Math.round(pct)));
    this.persistReleases();
    return true;
  }

  setPaused(bundleId: string, paused: boolean): boolean {
    const r = this.releases.get(bundleId);
    if (!r) return false;
    r.paused = paused;
    this.persistReleases();
    return true;
  }

  rollback(bundleId: string): boolean {
    const r = this.releases.get(bundleId);
    if (!r) return false;
    r.rolledBack = true;
    r.paused = true;
    this.persistReleases();
    return true;
  }

  readCiphertext(bundleId: string): Buffer | null {
    const r = this.releases.get(bundleId);
    if (!r || !existsSync(r.ciphertextPath)) return null;
    return readFileSync(r.ciphertextPath);
  }

  /**
   * Pick the best eligible release for a device: matches runtimeVersion/channel/platform,
   * newer than current, within the rollout bucket, not paused/rolled-back — highest
   * bundleVersion wins. This is where the cross-generation guarantee is enforced server-side.
   * @param device the reporting device context
   * @returns the chosen release or null for "no update"
   */
  pickEligible(device: DeviceContext): ReleaseRecord | null {
    const candidates = this.listReleases().filter((r) => {
      if (r.paused || r.rolledBack) return false;
      if (!isEligible(r.signedManifest.manifest, device).eligible) return false;
      return rolloutBucket(device.installId, r.bundleId) < r.rolloutPercentage;
    });
    if (candidates.length === 0) return null;
    return candidates.reduce((best, r) => (r.bundleVersion > best.bundleVersion ? r : best));
  }

  // ---- anti-replay: client nonces ---------------------------------------

  /**
   * Record a client request nonce; returns false if it was already seen (replay).
   * @param nonce the client-supplied nonce
   * @returns true if fresh, false if replayed
   */
  registerNonce(nonce: string): boolean {
    this.sweep();
    if (this.seenNonces.has(nonce)) return false;
    this.seenNonces.set(nonce, Date.now() + this.config.nonceTtlMs);
    return true;
  }

  // ---- one-time download tokens -----------------------------------------

  /** Issue a one-time, short-TTL token bound to a bundle. */
  issueDownloadToken(bundleId: string): string {
    const token = randomSecretB64(24);
    this.downloadTokens.set(token, { bundleId, expiresAt: Date.now() + this.config.downloadTokenTtlMs, used: false });
    return token;
  }

  /** Consume a download token; returns the bundleId once, then never again. */
  consumeDownloadToken(token: string): string | null {
    const rec = this.downloadTokens.get(token);
    if (!rec || rec.used || rec.expiresAt < Date.now()) return null;
    rec.used = true;
    return rec.bundleId;
  }

  // ---- server nonces (bind /confirm to a real /check) -------------------

  /** Issue a server nonce returned from /check and echoed on /confirm. */
  issueServerNonce(installId: string, bundleId: string): string {
    const nonce = randomSecretB64(18);
    this.serverNonces.set(nonce, { installId, bundleId, expiresAt: Date.now() + this.config.nonceTtlMs });
    return nonce;
  }

  /** Consume a server nonce, asserting it was issued to this install. */
  consumeServerNonce(nonce: string, installId: string): boolean {
    const rec = this.serverNonces.get(nonce);
    if (!rec || rec.expiresAt < Date.now() || rec.installId !== installId) return false;
    this.serverNonces.delete(nonce);
    return true;
  }

  // ---- adoption + auto-pause --------------------------------------------

  /**
   * Record a confirm event and auto-pause the rollout if the failure rate is too high.
   * @param bundleId the release
   * @param status the reported status
   * @returns whether this confirm triggered an auto-pause
   */
  recordConfirm(bundleId: string, status: ConfirmStatus): boolean {
    const r = this.releases.get(bundleId);
    if (!r) return false;
    r.adoption[status] += 1;
    const total = r.adoption.applied + r.adoption.healthy + r.adoption.failed + r.adoption.rolled_back;
    const failures = r.adoption.failed + r.adoption.rolled_back;
    let autoPaused = false;
    if (
      !r.paused &&
      total >= this.config.autoPauseMinSamples &&
      failures / total >= this.config.autoPauseFailureRate
    ) {
      r.paused = true;
      autoPaused = true;
    }
    this.persistReleases();
    return autoPaused;
  }

  /** Drop expired nonces (cheap periodic cleanup). */
  private sweep(): void {
    const now = Date.now();
    for (const [nonce, exp] of this.seenNonces) if (exp < now) this.seenNonces.delete(nonce);
  }

  /** Hash a request body for signature checks (helper kept here for locality). */
  static bodyHash(raw: Buffer): string {
    return sha256Hex(raw);
  }
}
