/**
 * The public OTA hook. Returns status, the current/available bundles, the native-version
 * policy (for the force-update gate), and actions (checkNow / applyUpdate / markHealthy /
 * rollback). Must be used within {@link DashOtaProvider}.
 */

import { useOtaContext } from './DashOtaProvider';
import type { OtaUpdateState } from './types';

/** Access the OTA state + actions. */
export function useOtaUpdate(): OtaUpdateState {
  return useOtaContext();
}
