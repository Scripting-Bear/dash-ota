---
sidebar_position: 1
title: react-native-dash-ota
---

# `react-native-dash-ota`

The public exports of the client library: eight values and twenty types. Nothing else can be
imported, and the native `DashOta` module isn't exported. Every symbol has a generated page with
its full signature and defaults under [Client reference](/docs/api/client/).

## Components and hooks

### `DashOtaProvider`

```tsx
function DashOtaProvider(props: { config: OtaConfig; children: ReactNode }): ReactElement
```

Wrap your app root with it. It registers the device key, checks for an update at launch and
exposes the state through `useOtaUpdate()`. See [Provider & config](/docs/react-native/provider-config).

### `useOtaUpdate()`

```ts
function useOtaUpdate(): OtaUpdateState
```

Returns the OTA state and actions. Throws when used outside `DashOtaProvider`. See
[useOtaUpdate](/docs/react-native/use-ota-update).

### `isDeviceKeyHardwareBacked()`

```ts
function isDeviceKeyHardwareBacked(): boolean
```

Whether this install's device key lives in hardware (Android Keystore / iOS Secure Enclave). It's
the device's own answer; the server can't verify it.

## Types

### `OtaConfig`

```ts
interface OtaConfig {
  storage: OtaStorage;                                   // required
  appVersion: string;                                    // required
  getEnrollToken?: () => Promise<string | undefined>;    // needed if the backend checks enroll tokens (the default)
  enabled?: boolean;                                     // default true; false never checks or applies
  autoCheckOnLaunch?: boolean;                           // default true
  autoStage?: boolean;                                   // default true
  mandatory?: 'auto-download' | 'announce';              // default 'auto-download'
  uiCopy?: Partial<Record<keyof OtaUiCopy, Partial<OtaUiPhaseCopy>>>;
  autoMarkHealthyMs?: number;                            // off unless set
  checkOnAppForeground?: boolean;                        // default false
  onStatusChange?: (status: OtaStatus) => void;
  storeUrl?: string;                                     // https://, market:// or itms-apps://
  serverUrlOverride?: string;
  logger?: OtaLogger;                                    // default consoleLogger
  transport?: TransportSecurity;
  attestor?: IntegrityAttestor;
}
```

### `OtaUpdateState`

```ts
interface OtaUpdateState {
  ui: OtaUi;                                  // ready-made state for an update banner or screen
  status: OtaStatus;
  channel: string;
  currentBundle: BundleMeta | null;
  availableUpdate: AvailableUpdate | null;
  isMandatory: boolean;
  nativePolicy: NativeVersionPolicy | null;
  progress: number;                           // 0–1; Android only, see ui.progress
  error: string | null;
  checkNow(): Promise<void>;
  downloadUpdate(): Promise<boolean>;         // true when a bundle ended up staged
  applyUpdate(restart?: boolean): Promise<boolean>; // false when nothing was staged
  markHealthy(): void;
  rollback(): Promise<void>;
}
```

### `OtaUi`

```ts
interface OtaUi {
  phase: OtaPhase;             // 'none' | 'available' | 'working' | 'ready' | 'error'
  visible: boolean;
  title: string;
  description: string;
  cta: string | null;
  ctaEnabled: boolean;
  busy: boolean;
  progress: number | null;     // null while indeterminate (always on iOS)
  blocking: boolean;           // a verified mandatory update is waiting
  action(): Promise<void>;     // does whatever the CTA says
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

- Values: `consoleLogger`, `DEFAULT_UI_COPY`, `STORAGE_KEYS`, `noopTransportSecurity`,
  `noopIntegrityAttestor`.
- Types: `DashOtaProviderProps`, `TransportSecurity`, `IntegrityAttestor`, `Channel`, `Platform`,
  `OtaStatus`, `OtaPhase`, `OtaUiCopy`, `OtaUiPhaseCopy`, `BundleMeta`, `OtaNativeState`,
  `NativeVersionPolicy`, `SignedManifest`, `CheckResponse`, `AvailableUpdate`, `OtaLogger`.
