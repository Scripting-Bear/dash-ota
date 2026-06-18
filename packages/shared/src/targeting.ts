/**
 * Targeting & eligibility — the rules that decide whether a given OTA may be served to a
 * given device. The **runtimeVersion** gate is the load-bearing one: it guarantees an OTA
 * built for one native generation can never land on a different one (the store-vs-OTA bug).
 *
 * Includes a deliberately small **semver-subset** matcher for `targetAppVersions` (enough
 * for ranges like ">=1.2.0 <1.3.0", "1.2.x", "1.2.3", "*") so the POC has no external
 * semver dependency. Swap for the `semver` package if richer ranges are needed.
 *
 * @module targeting
 */

import { sha256Hex } from './crypto.js';
import type { Channel, Manifest, Platform } from './manifest.js';

/** What the device reports about itself on `/check`. */
export interface DeviceContext {
  platform: Platform;
  channel: Channel;
  /** the binary's embedded native-compatibility key. */
  runtimeVersion: string;
  /** marketing/build version string, e.g. "1.2.0". */
  appVersion: string;
  /** native build number (store build). */
  buildNumber: number;
  /** version of the bundle currently applied (0 = embedded). */
  currentBundleVersion: number;
  /** stable per-install id (hashed) used for deterministic rollout bucketing. */
  installId: string;
}

/** Result of an eligibility check, with a machine-readable reason when not eligible. */
export interface EligibilityResult {
  eligible: boolean;
  reason?:
    | 'platform-mismatch'
    | 'channel-mismatch'
    | 'runtime-mismatch'
    | 'not-newer'
    | 'native-too-old'
    | 'app-version-excluded';
}

/** Parse "1.2.3" → [1,2,3]; missing/"x"/"*" segments become -1 (wildcard). */
function parseVersion(v: string): [number, number, number] {
  const parts = v.trim().replace(/^v/, '').split('.');
  const seg = (i: number): number => {
    const p = parts[i];
    if (p === undefined || p === 'x' || p === 'X' || p === '*') return -1;
    const n = Number.parseInt(p, 10);
    return Number.isNaN(n) ? -1 : n;
  };
  return [seg(0), seg(1), seg(2)];
}

/** Compare two concrete versions (wildcards treated as 0). Returns -1/0/1. */
function compareVersions(a: string, b: string): number {
  const av = parseVersion(a);
  const bv = parseVersion(b);
  for (let i = 0; i < 3; i++) {
    const rawX = av[i] ?? 0;
    const rawY = bv[i] ?? 0;
    const x = rawX === -1 ? 0 : rawX;
    const y = rawY === -1 ? 0 : rawY;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** Does `version` satisfy a single comparator like ">=1.2.0", "1.2.x", "1.2.3", "*"? */
function satisfiesComparator(version: string, comparator: string): boolean {
  const c = comparator.trim();
  if (c === '' || c === '*') return true;
  const m = c.match(/^(>=|<=|>|<|=)?\s*(.+)$/);
  if (!m) return false;
  const op = m[1] ?? '=';
  const target = m[2] ?? '';
  // Wildcard form like "1.2.x" → match on the concrete segments only.
  if (op === '=' && /[x*]/i.test(target)) {
    const tv = parseVersion(target);
    const vv = parseVersion(version);
    return tv.every((seg, i) => seg === -1 || seg === vv[i]);
  }
  const cmp = compareVersions(version, target);
  switch (op) {
    case '>=':
      return cmp >= 0;
    case '<=':
      return cmp <= 0;
    case '>':
      return cmp > 0;
    case '<':
      return cmp < 0;
    default:
      return cmp === 0;
  }
}

/**
 * Does `version` satisfy a whitespace-joined range (all comparators must hold)?
 * @param version concrete version, e.g. "1.2.0"
 * @param range e.g. ">=1.2.0 <1.3.0", "1.2.x", "*"
 * @returns true if every comparator is satisfied
 */
export function satisfiesAppVersionRange(version: string, range: string): boolean {
  return range
    .trim()
    .split(/\s+/)
    .every((comparator) => satisfiesComparator(version, comparator));
}

/**
 * Deterministic rollout bucket in [0, 99] for a device+bundle. Stable across checks, so a
 * device never flips in/out of a staged rollout mid-flight.
 * @param installId stable per-install id
 * @param bundleId the candidate bundle id
 * @returns integer 0..99
 */
export function rolloutBucket(installId: string, bundleId: string): number {
  const hex = sha256Hex(Buffer.from(`${installId}:${bundleId}`, 'utf8')).slice(0, 8);
  return Number.parseInt(hex, 16) % 100;
}

/**
 * Core eligibility (everything except rollout %, which depends on mutable release state and
 * is applied by the backend). The runtimeVersion gate here is what stops cross-generation OTAs.
 * @param manifest the candidate manifest
 * @param device the reporting device
 * @returns eligibility with a reason on failure
 */
export function isEligible(manifest: Manifest, device: DeviceContext): EligibilityResult {
  if (manifest.platform !== device.platform) return { eligible: false, reason: 'platform-mismatch' };
  if (manifest.channel !== device.channel) return { eligible: false, reason: 'channel-mismatch' };
  if (manifest.runtimeVersion !== device.runtimeVersion) return { eligible: false, reason: 'runtime-mismatch' };
  if (manifest.bundleVersion <= device.currentBundleVersion) return { eligible: false, reason: 'not-newer' };
  if (typeof manifest.minNativeBuild === 'number' && device.buildNumber < manifest.minNativeBuild) {
    return { eligible: false, reason: 'native-too-old' };
  }
  if (manifest.targetAppVersions && !satisfiesAppVersionRange(device.appVersion, manifest.targetAppVersions)) {
    return { eligible: false, reason: 'app-version-excluded' };
  }
  return { eligible: true };
}
