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
 * @returns the {@link OtaUpdateState}: `ui` (the derived view model — read this), plus the raw
 *   `status`, `channel`, `currentBundle`, `availableUpdate`, `isMandatory`, `nativePolicy`,
 *   `progress`, `error`, and the actions `checkNow`, `downloadUpdate`, `applyUpdate`, `markHealthy`,
 *   `rollback` for non-standard flows.
 *
 * @example The whole standard flow — announce, download, restart — is `ota.ui`:
 * ```tsx
 * function UpdateRow() {
 *   const { ui, markHealthy } = useOtaUpdate();
 *
 *   // Call once your first real screen is usable (drives the crash-loop breaker).
 *   useEffect(() => markHealthy(), []);
 *
 *   if (!ui.visible) return null;
 *   return (
 *     <View>
 *       <Text>{ui.title}</Text>
 *       <Text>{ui.description}</Text>
 *       {ui.busy && <ActivityIndicator />}
 *       {ui.cta && <Button title={ui.cta} disabled={!ui.ctaEnabled} onPress={ui.action} />}
 *     </View>
 *   );
 * }
 * ```
 * `ui.blocking` is true for a mandatory release — render the same thing as a non-dismissible modal
 * instead of a row, and the update downloads itself.
 */
export function useOtaUpdate(): OtaUpdateState {
  return useOtaContext();
}
