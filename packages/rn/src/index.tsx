/**
 * react-native-dash-ota — public API.
 */

export { DashOtaProvider } from './DashOtaProvider';
export type { DashOtaProviderProps } from './DashOtaProvider';
export { useOtaUpdate } from './useOtaUpdate';

export { consoleLogger, STORAGE_KEYS } from './config';
export type { OtaConfig, OtaStorage } from './config';

export {
  noopTransportSecurity,
  noopIntegrityAttestor,
} from './verifiers';
export type { TransportSecurity, IntegrityAttestor } from './verifiers';

export type {
  Channel,
  Platform,
  OtaStatus,
  BundleMeta,
  OtaNativeState,
  NativeVersionPolicy,
  SignedManifest,
  CheckResponse,
  AvailableUpdate,
  OtaLogger,
  OtaUpdateState,
} from './types';
