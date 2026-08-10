/**
 * react-native-dash-ota — public API.
 */

export { DashOtaProvider } from './DashOtaProvider';
export type { DashOtaProviderProps } from './DashOtaProvider';
export { useOtaUpdate } from './useOtaUpdate';

export { consoleLogger, DEFAULT_UI_COPY, STORAGE_KEYS } from './config';
export type { OtaConfig, OtaStorage } from './config';

export { isDeviceKeyHardwareBacked } from './deviceKey';

export { noopTransportSecurity, noopIntegrityAttestor } from './verifiers';
export type { TransportSecurity, IntegrityAttestor } from './verifiers';

export type {
  Channel,
  Platform,
  OtaStatus,
  OtaPhase,
  OtaUi,
  OtaUiCopy,
  OtaUiPhaseCopy,
  BundleMeta,
  OtaNativeState,
  NativeVersionPolicy,
  SignedManifest,
  CheckResponse,
  AvailableUpdate,
  OtaLogger,
  OtaUpdateState,
} from './types';
