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
  | 'downloading'
  | 'staged'
  | 'apply-pending'
  | 'error';

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
  /** manually trigger a check (+ auto-download/stage). */
  checkNow: () => Promise<void>;
  /** apply a staged update on next launch (or restart for mandatory). */
  applyUpdate: (restart?: boolean) => Promise<void>;
  /** mark the running bundle healthy (call once the app is genuinely usable). */
  markHealthy: () => void;
  /** force a rollback to last-known-good. */
  rollback: () => Promise<void>;
}
