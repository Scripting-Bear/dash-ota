/**
 * Host-injected configuration. The package is storage- and transport-agnostic: the host app
 * provides a key/value storage adapter (for the install id), an optional logger, and optional
 * pinning/attestation plug-ins. Server URL / channel / runtimeVersion / public keys come from
 * the **native** side (embedded per build flavour), so they can't be tampered from JS. The
 * per-request signing key is a non-exportable hardware key held in the Keystore / Enclave.
 */

import type { IntegrityAttestor, TransportSecurity } from './verifiers';
import type { OtaLogger, OtaStatus, OtaUiCopy, OtaUiPhaseCopy } from './types';

/** Minimal async key/value storage (e.g. AsyncStorage or secure storage). */
export interface OtaStorage {
  getItem: (key: string) => Promise<string | null>;
  setItem: (key: string, value: string) => Promise<void>;
}

/** Configuration passed to {@link DashOtaProvider}. */
export interface OtaConfig {
  /** persistence for the install id (the signing key lives in the hardware Keystore / Enclave). */
  storage: OtaStorage;
  /** app marketing version (for `targetAppVersions` matching). */
  appVersion: string;
  /**
   * Master switch (default `true`). When `false`, the provider mounts but performs **no** OTA
   * activity — no enroll, check, download, or apply — and reports status `disabled`. Use it to
   * withhold OTA from a runtime you don't trust (e.g. a jailbroken / rooted device) so it keeps
   * running only the store-shipped binary.
   */
  enabled?: boolean;
  /** check for an update automatically on launch (default true). */
  autoCheckOnLaunch?: boolean;
  /** automatically stage + schedule an apply when an update is found (default true). */
  autoStage?: boolean;
  /**
   * What to do about a release published with `mandatory: true` (default `'auto-download'`).
   *
   * - `'auto-download'` — ignore `autoStage: false` and download it immediately, so the user only
   *   ever has to press Restart. Combined with {@link OtaUi.blocking} (set for every mandatory
   *   update) this is the force-update flow: the host refuses to dismiss the UI, the bundle
   *   arrives on its own.
   * - `'announce'` — treat it like any optional update; only `blocking` marks it as required.
   */
  mandatory?: 'auto-download' | 'announce';
  /**
   * Override any of the strings in {@link OtaUi} (per phase: `title`, `description`, `cta`).
   * Partial and per-phase-partial: anything omitted keeps the built-in copy. `{version}` inside a
   * string is replaced with the relevant bundle version. Use it for your own tone or localization.
   *
   * @example
   * ```ts
   * uiCopy: { ready: { title: 'Restart to finish updating', cta: 'Restart now' } }
   * ```
   */
  uiCopy?: Partial<Record<keyof OtaUiCopy, Partial<OtaUiPhaseCopy>>>;
  /**
   * Auto-promote the running bundle to last-known-good this many ms after a successful mount,
   * so hosts don't have to wire `markHealthy()` by hand. Omit (default) to keep it **manual** —
   * the safest choice, since calling `markHealthy()` only after your real first screen renders
   * gives the crash-loop breaker its full protection. A value like `4000` is a reasonable
   * plug-and-play default for simple apps.
   */
  autoMarkHealthyMs?: number;
  /** re-run a check when the app returns to the foreground (default false). */
  checkOnAppForeground?: boolean;
  /** observability hook fired on every lifecycle status transition. */
  onStatusChange?: (status: OtaStatus) => void;
  /** override the native-embedded server URL. Tests and local development only — a production
   * build must take the URL from native, where JS cannot reach it. */
  serverUrlOverride?: string;
  /** returns the app's authenticated session token, attached to enroll (ties the device key to a user). */
  getEnrollToken?: () => Promise<string | undefined>;
  logger?: OtaLogger;
  transport?: TransportSecurity;
  attestor?: IntegrityAttestor;
}

/** Storage keys used internally. */
export const STORAGE_KEYS = {
  installId: 'dash-ota.installId',
  /**
   * Marker proving this install already enrolled its current device key, so we don't re-POST
   * `/enroll` (and re-attest, burning attestation quota) on every cold start. Value =
   * `sha256(installId + ':' + devicePublicKeyB64)`, so a key rotation or reinstall re-enrolls.
   */
  enrolled: 'dash-ota.enrolled',
} as const;

/**
 * Built-in copy for {@link OtaUi}. Deliberately plain — override per phase with
 * {@link OtaConfig.uiCopy} to match your product's voice.
 */
export const DEFAULT_UI_COPY: OtaUiCopy = {
  available: {
    title: 'Update available',
    description: 'Version {version} is ready to download.',
    cta: 'Download',
  },
  working: {
    title: 'Downloading update',
    description: 'Keep the app open while the update downloads.',
    cta: null,
  },
  ready: {
    title: 'Restart to finish',
    description: 'Version {version} is ready to apply.',
    cta: 'Restart now',
  },
  error: {
    title: "Update didn't finish",
    description: 'Something went wrong. You can try again.',
    cta: 'Try again',
  },
};

/** Default console logger. */
export const consoleLogger: OtaLogger = {
  info: (m) => console.log(`[dash-ota] ${m}`),
  warn: (m) => console.warn(`[dash-ota] ${m}`),
  error: (m) => console.error(`[dash-ota] ${m}`),
};
