/**
 * Public TypeScript types for react-native-dash-ota. These describe the runtime shapes the
 * native module returns and the protocol payloads (a RN-safe subset that does NOT import any
 * Node APIs — the native side owns the trust-critical crypto).
 */

export type Channel = 'dev' | 'uat' | 'prod';
export type Platform = 'ios' | 'android';

/** Lifecycle status surfaced by {@link useOtaUpdate}. */
export type OtaStatus =
  | 'idle'
  | 'checking'
  | 'up-to-date'
  /**
   * An eligible update exists but nothing has been downloaded yet — only reachable with
   * `autoStage: false`, where the host decides when to spend the user's bandwidth. Call
   * `downloadUpdate()` to proceed.
   */
  | 'update-available'
  | 'downloading'
  | 'staged'
  | 'apply-pending'
  | 'error'
  /** OTA is switched off for this runtime (`config.enabled === false`) — no enroll/check/apply. */
  | 'disabled';

/** Metadata for a bundle (embedded or applied). */
export interface BundleMeta {
  bundleId: string;
  bundleVersion: number;
  runtimeVersion: string;
  isEmbedded: boolean;
}

/** Native slot/rollback state. */
export interface OtaNativeState {
  currentBundleVersion: number;
  pendingBundleId: string | null;
  lastKnownGoodVersion: number;
  otaDisabled: boolean;
}

/** Native-version policy returned by `/check` (drives the force-update gate). */
export interface NativeVersionPolicy {
  minSupportedNativeVersion: number;
  severity: 'none' | 'soft' | 'hard';
  storeUrl?: string;
}

/** A signed manifest as received from `/check` (opaque to JS; verified natively). */
export interface SignedManifest {
  manifest: {
    bundleId: string;
    runtimeVersion: string;
    bundleVersion: number;
    platform: Platform;
    channel: Channel;
    mandatory: boolean;
    releaseNotes?: string;
    [key: string]: unknown;
  };
  signatureB64: string;
  keyId: string;
}

/** The `/check` response shape. */
export interface CheckResponse {
  update: SignedManifest | null;
  downloadToken?: string;
  serverNonce: string;
  nativePolicy: NativeVersionPolicy;
}

/** An available update surfaced to the app. */
export interface AvailableUpdate {
  bundleId: string;
  bundleVersion: number;
  mandatory: boolean;
  releaseNotes?: string;
}

/** Host-provided logger (defaults to console). */
export interface OtaLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
}

/** What `useOtaUpdate()` returns. */
export interface OtaUpdateState {
  status: OtaStatus;
  /** the build flavour's channel (dev/uat/prod), embedded natively. */
  channel: string;
  currentBundle: BundleMeta | null;
  availableUpdate: AvailableUpdate | null;
  isMandatory: boolean;
  nativePolicy: NativeVersionPolicy | null;
  progress: number;
  error: string | null;
  /** manually trigger a check (+ auto-download/stage unless `autoStage: false`). */
  checkNow: () => Promise<void>;
  /**
   * Download + verify + stage the update announced by the last check. Only needed with
   * `autoStage: false`, where the check stops at `'update-available'` so the host can ask the user
   * before spending bandwidth; a mandatory update downloads itself regardless.
   *
   * Resolves **false** when there is nothing to download (no announced update, or the download
   * material has expired — re-run `checkNow()`). On success the status ends at `'apply-pending'`.
   */
  downloadUpdate: () => Promise<boolean>;
  /**
   * Apply a staged update on next launch (or restart now). Resolves **false** when nothing is
   * staged yet — e.g. the download is still running — in which case no restart happens and the
   * status is left alone, so a host UI can keep waiting instead of promising a restart that would
   * discard the partial download.
   */
  applyUpdate: (restart?: boolean) => Promise<boolean>;
  /** mark the running bundle healthy (call once the app is genuinely usable). */
  markHealthy: () => void;
  /** force a rollback to last-known-good. */
  rollback: () => Promise<void>;
}
