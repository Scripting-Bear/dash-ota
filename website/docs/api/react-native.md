---
sidebar_position: 1
title: react-native-dash-ota
---

# API — `react-native-dash-ota`

The public exports of the client library.

## Components & hooks

### `DashOtaProvider`
```tsx
function DashOtaProvider(props: { config: OtaConfig; children: ReactNode }): ReactElement
```
Wrap your app root. Enrolls the device key, checks on launch, exposes state via `useOtaUpdate`.
→ [Provider & config](/docs/react-native/provider-config)

### `useOtaUpdate()`
```ts
function useOtaUpdate(): OtaUpdateState
```
Returns OTA state + actions. Must be used within `DashOtaProvider`. → [useOtaUpdate](/docs/react-native/use-ota-update)

## Types

### `OtaConfig`
```ts
interface OtaConfig {
  storage: OtaStorage;                 // required
  appVersion: string;                  // required
  autoCheckOnLaunch?: boolean;         // default true
  autoStage?: boolean;                 // default true
  autoMarkHealthyMs?: number;
  checkOnAppForeground?: boolean;
  onStatusChange?: (s: OtaStatus) => void;
  getEnrollToken?: () => Promise<string | undefined>;
  serverUrlOverride?: string;
  logger?: OtaLogger;
  transport?: TransportSecurity;
  attestor?: IntegrityAttestor;
}
```

### `OtaUpdateState`
```ts
interface OtaUpdateState {
  status: OtaStatus;
  channel: string;
  currentBundle: BundleMeta | null;
  availableUpdate: AvailableUpdate | null;
  isMandatory: boolean;
  nativePolicy: NativeVersionPolicy | null;
  progress: number;
  error: string | null;
  checkNow(): Promise<void>;
  applyUpdate(restart?: boolean): Promise<void>;
  markHealthy(): void;
  rollback(): Promise<void>;
}
```

### `OtaStorage`
```ts
interface OtaStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}
```

### Other exports
- `OtaStatus`, `BundleMeta`, `AvailableUpdate`, `NativeVersionPolicy`, `OtaLogger`, `Channel`,
  `Platform`, `SignedManifest`, `CheckResponse`.
- `consoleLogger`, `STORAGE_KEYS`.
- `TransportSecurity`, `IntegrityAttestor`, `noopTransportSecurity`, `noopIntegrityAttestor`.

:::note
A complete, auto-generated reference (every type and field) is generated from the source TSDoc.
The pages above cover the surface you'll use day-to-day.
:::
