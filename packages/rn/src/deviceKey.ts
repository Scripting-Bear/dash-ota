/**
 * Device-identity introspection. The signing key itself never leaves native — this only reports
 * *where* it lives, so a host app can verify (or display) its security posture.
 */

import DashOta from './NativeDashOta';

/**
 * Whether the device's OTA signing key lives in secure hardware — Android StrongBox/TEE or the iOS
 * Secure Enclave — rather than a software Keychain/Keystore fallback.
 *
 * Worth surfacing in a diagnostics screen: simulators and emulators have no secure element and
 * always report `false`, so this is the only way to confirm on real hardware that enrollment used a
 * non-exportable key. Returns `false` if the native side cannot answer.
 *
 * @returns true when the key is hardware-backed.
 *
 * @example
 * ```ts
 * import { isDeviceKeyHardwareBacked } from 'react-native-dash-ota';
 * console.log('hardware-backed key:', isDeviceKeyHardwareBacked());
 * ```
 */
export function isDeviceKeyHardwareBacked(): boolean {
  try {
    return DashOta.isDeviceKeyHardwareBacked();
  } catch {
    return false;
  }
}
