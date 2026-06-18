import { TurboModuleRegistry, type TurboModule } from 'react-native';

/**
 * Native TurboModule spec for dash-ota. The trust-critical work (Ed25519 verify, AES-GCM
 * decrypt, per-file SHA-256, slot management, crash-rollback) and the heavy bundle download
 * live in native so they run before JS and can't be bypassed by a compromised bundle. JS
 * only orchestrates the small JSON `/check` / `/confirm` calls.
 *
 * Complex return values are passed as `Object` (generic dict) for codegen simplicity; their
 * runtime shapes are described by the TS types in `./types`.
 */
export interface Spec extends TurboModule {
  // --- Embedded per-flavour build config (from Android BuildConfig / iOS Info.plist) ---
  getRuntimeVersion(): string;
  getChannel(): string;
  getServerUrl(): string;
  /** base64 raw Ed25519 public key(s) embedded in the binary, comma-separated for a key ring. */
  getPublicKeysB64(): string;
  getNativeBuildNumber(): number;

  // --- Bundle state ---
  /** `{ bundleId, bundleVersion, runtimeVersion, isEmbedded }` of the active bundle. */
  getCurrentBundleMeta(): Promise<Object>;
  /** `{ currentBundleVersion, pendingBundleId, lastKnownGoodVersion, otaDisabled }`. */
  getState(): Promise<Object>;

  // --- Apply pipeline (download happens natively to keep ~MBs off the bridge) ---
  /**
   * Download the ciphertext from `downloadUrl` (with the one-time token), then Ed25519-verify
   * the manifest against the embedded key, verify the ciphertext hash, AES-256-GCM decrypt,
   * unpack, verify every file's SHA-256, and stage as `pending`. Fails closed on any error.
   * @returns `{ bundleId, bundleVersion }` on success.
   */
  downloadAndStage(
    downloadUrl: string,
    downloadToken: string,
    manifestJson: string,
    signatureB64: string
  ): Promise<Object>;

  /**
   * True if a bundle was disabled by the crash-loop breaker (so the client skips re-downloading
   * a known-bad bundle the backend still offers).
   */
  isBundleDisabled(bundleId: string): boolean;
  /**
   * Return (and clear) the bundleId most recently disabled by a crash-loop revert, so the
   * recovered app can report the failure to the backend exactly once (drives server auto-pause).
   * Empty string if none.
   */
  consumeFailedReport(): string;

  /** Promote `pending` to apply on next cold start. */
  applyOnNextLaunch(): Promise<boolean>;
  /** Mark the running bundle healthy (clears the crash-loop counter, promotes to last-known-good). */
  markHealthy(): void;
  /** Revert to the last-known-good bundle. */
  rollback(): Promise<boolean>;
  /** Best-effort in-process restart (mandatory updates only; prefer cold start). */
  restart(): void;

  // --- Hardware-backed device identity (closes the enrollment-bootstrap gap without pinning) ---
  /**
   * The device's public key (SPKI-DER, base64), from a hardware-backed EC P-256 keypair
   * generated on first use in the AndroidKeyStore / iOS Secure Enclave (Keychain). The private
   * key never leaves the device, so there is no secret to intercept at enrollment.
   */
  getDevicePublicKeyB64(): string;
  /** ECDSA-P256-SHA256 signature (DER, base64) of `message` using the hardware device key. */
  signWithDeviceKey(message: string): string;
  /** SHA-256 of a UTF-8 string, hex output (request body hashing). */
  sha256Hex(message: string): string;
}

export default TurboModuleRegistry.getEnforcing<Spec>('DashOta');
