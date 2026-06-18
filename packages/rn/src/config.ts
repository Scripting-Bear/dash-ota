/**
 * Host-injected configuration. The package is storage- and transport-agnostic: the host app
 * provides a key/value storage adapter (for the install id + HMAC secret), an optional
 * logger, and optional pinning/attestation plug-ins. Server URL / channel / runtimeVersion /
 * public keys come from the **native** side (embedded per build flavour), so they can't be
 * tampered from JS.
 */

import type { IntegrityAttestor, TransportSecurity } from './verifiers';
import type { OtaLogger, OtaStatus } from './types';

/** Minimal async key/value storage (e.g. AsyncStorage or secure storage). */
export interface OtaStorage {
  getItem: (key: string) => Promise<string | null>;
  setItem: (key: string, value: string) => Promise<void>;
}

/** Configuration passed to {@link DashOtaProvider}. */
export interface OtaConfig {
  /** persistence for the install id + per-install HMAC secret. */
  storage: OtaStorage;
  /** app marketing version (for `targetAppVersions` matching). */
  appVersion: string;
  /** check for an update automatically on launch (default true). */
  autoCheckOnLaunch?: boolean;
  /** automatically stage + schedule an apply when an update is found (default true). */
  autoStage?: boolean;
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
  /** override the native-embedded server URL (POC/testing only). */
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
} as const;

/** Default console logger. */
export const consoleLogger: OtaLogger = {
  info: (m) => console.log(`[dash-ota] ${m}`),
  warn: (m) => console.warn(`[dash-ota] ${m}`),
  error: (m) => console.error(`[dash-ota] ${m}`),
};
