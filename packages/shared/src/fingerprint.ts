/**
 * runtimeVersion fingerprinting. The runtimeVersion is the **native-compatibility key**: it
 * must change whenever the native layer changes (native deps, native dirs, Hermes version)
 * and stay stable otherwise. The CLI gathers the inputs from a project and calls
 * {@link computeRuntimeVersion}; the *same* value is stamped into the binary at build time
 * and into every OTA at publish, so device and OTA always agree.
 *
 * This module is pure: it hashes the inputs you give it. Gathering them (reading
 * `android/`, `ios/`, native deps, `hermesc --version`) is the CLI's job.
 *
 * @module fingerprint
 */

import { sha256Hex } from './crypto.js';

/** The native inputs whose change should invalidate JS↔native compatibility. */
export interface FingerprintInputs {
  /** sorted "name@version" of every dependency that contributes native code. */
  nativeDependencies: string[];
  /** hashes of native source trees, e.g. { 'android': '<sha>', 'ios': '<sha>' }. */
  nativeDirHashes: Record<string, string>;
  /** the Hermes compiler version string the binary ships (HBC ABI). */
  hermesVersion: string;
  /** React Native version (its native runtime is part of the ABI). */
  reactNativeVersion: string;
  /** optional manual salt, lets you force a new generation or pin a known-compatible one. */
  salt?: string;
}

/**
 * Compute a stable, short runtimeVersion from native inputs.
 * @param inputs the native fingerprint inputs
 * @returns a 16-hex-char runtimeVersion (e.g. "a1b2c3d4e5f60718")
 * @example
 * computeRuntimeVersion({
 *   nativeDependencies: ['react-native-reanimated@4.0.0', 'react-native-dash-ota@0.1.0'],
 *   nativeDirHashes: { android: 'aa..', ios: 'bb..' },
 *   hermesVersion: '0.12.0',
 *   reactNativeVersion: '0.79.2',
 * })
 */
export function computeRuntimeVersion(inputs: FingerprintInputs): string {
  const canonical = JSON.stringify({
    deps: [...inputs.nativeDependencies].sort(),
    dirs: Object.fromEntries(Object.entries(inputs.nativeDirHashes).sort(([a], [b]) => a.localeCompare(b))),
    hermes: inputs.hermesVersion,
    rn: inputs.reactNativeVersion,
    salt: inputs.salt ?? '',
  });
  return sha256Hex(Buffer.from(canonical, 'utf8')).slice(0, 16);
}
