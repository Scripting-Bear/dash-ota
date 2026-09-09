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
  /** verified, staged, and armed to load on the next launch — the app must restart to run it. */
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
  /** SHA-256 of the running JS bytecode; the server uses it to offer a delta. '' when unknown. */
  bundleSha256: string;
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

/**
 * What an update UI actually needs to know — the four states a user can be in, derived from
 * {@link OtaStatus} so hosts never map raw lifecycle statuses themselves.
 *
 * - `none` — nothing to show (idle, up-to-date, disabled).
 * - `available` — an update exists and is waiting for the user to start the download.
 * - `working` — checking or downloading; show progress and no action.
 * - `ready` — verified and staged; the app must restart to run it.
 * - `error` — the last attempt failed; the action retries.
 */
export type OtaPhase = 'none' | 'available' | 'working' | 'ready' | 'error';

/** Copy for one {@link OtaPhase}. `{version}` is substituted with the relevant bundle version. */
export interface OtaUiPhaseCopy {
  title: string;
  description: string;
  /** button label, or `null` for a phase with no action (e.g. while downloading). */
  cta: string | null;
}

/** Overridable copy per actionable phase — pass a partial via `OtaConfig.uiCopy`. */
export type OtaUiCopy = Record<Exclude<OtaPhase, 'none'>, OtaUiPhaseCopy>;

/**
 * A ready-to-render view model for the update UI. Everything a row/banner/modal needs, so the host
 * renders it and calls {@link OtaUi.action} — no status mapping, no in-flight guard, no branching
 * between download and restart.
 */
export interface OtaUi {
  phase: OtaPhase;
  /** convenience for `phase !== 'none'`. */
  visible: boolean;
  title: string;
  description: string;
  cta: string | null;
  /** false while an action is running, or when the phase has no action. */
  ctaEnabled: boolean;
  /** an operation is in flight — show a spinner and keep the action inert. */
  busy: boolean;
  /** 0..1 when known, `null` when the download reports no granular progress (show indeterminate). */
  progress: number | null;
  /** the update is mandatory: the host should not let the user dismiss or defer this UI. */
  blocking: boolean;
  /** performs the correct next step for the current phase (download → restart → retry). */
  action: () => Promise<void>;
}

/** Host-provided logger (defaults to console). */
export interface OtaLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
}

/** What `useOtaUpdate()` returns. */
export interface OtaUpdateState {
  /**
   * The one thing a host UI should read: a derived, ready-to-render view model with a single
   * {@link OtaUi.action}. Prefer this over `status` — the raw statuses below are for diagnostics
   * and for hosts that need to build a non-standard flow.
   */
  ui: OtaUi;
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
   * Escape hatch — {@link OtaUi.action} already does this at the right time.
   *
   * Download + verify + stage the update announced by the last check. Only needed with
   * `autoStage: false`, where the check stops at `'update-available'` so the host can ask the user
   * before spending bandwidth; a mandatory update downloads itself regardless.
   *
   * Resolves **false** when there is nothing to download (no announced update, or the download
   * material has expired — re-run `checkNow()`). On success the status ends at `'apply-pending'`.
   */
  downloadUpdate: () => Promise<boolean>;
  /**
   * Escape hatch — {@link OtaUi.action} already does this at the right time.
   *
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
