/**
 * The public OTA hook. Returns status, the current/available bundles, the native-version
 * policy (for the force-update gate), and actions (checkNow / applyUpdate / markHealthy /
 * rollback). Must be used within {@link DashOtaProvider}.
 */

import { useOtaContext } from './DashOtaProvider';
import type { OtaUpdateState } from './types';

/**
 * Read OTA state and drive actions. Must be used within {@link DashOtaProvider}.
 *
 * @returns the {@link OtaUpdateState}: `status`, `channel`, `currentBundle`, `availableUpdate`,
 *   `isMandatory`, `nativePolicy`, `progress`, `error`, and the actions `checkNow`, `applyUpdate`,
 *   `markHealthy`, `rollback`.
 *
 * @example
 * ```tsx
 * function UpdateControls() {
 *   const ota = useOtaUpdate();
 *
 *   // Call once your first real screen is usable (drives the crash-loop breaker).
 *   useEffect(() => ota.markHealthy(), []);
 *
 *   return (
 *     <>
 *       <Button title="Check now" onPress={ota.checkNow} />
 *       {ota.availableUpdate && <Button title="Apply" onPress={() => ota.applyUpdate()} />}
 *       <Button title="Roll back" onPress={ota.rollback} />
 *     </>
 *   );
 * }
 * ```
 */
export function useOtaUpdate(): OtaUpdateState {
  return useOtaContext();
}
