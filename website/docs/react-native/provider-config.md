---
sidebar_position: 5
title: Provider & config
description: <DashOtaProvider> and every OtaConfig option.
---

# Provider & config

Wrap your app once. The provider enrolls the device key, checks on launch (configurable), and
exposes everything through [`useOtaUpdate()`](/docs/react-native/use-ota-update).

```tsx
import { DashOtaProvider } from 'react-native-dash-ota';
import type { OtaConfig } from 'react-native-dash-ota';

const config: OtaConfig = {
  appVersion: '1.4.0',
  storage,                                       // your AsyncStorage / secure-storage adapter
  getEnrollToken: () => auth.getSessionToken(),  // ties the device key to a real user session
  autoCheckOnLaunch: true,
  autoStage: true,
  checkOnAppForeground: true,
  onStatusChange: (s) => log('[ota]', s),
  // autoMarkHealthyMs: 4000,                     // optional; prefer manual markHealthy()
};

export default function Root() {
  return (
    <DashOtaProvider config={config}>
      <App />
    </DashOtaProvider>
  );
}
```

## `OtaConfig` reference

| Field | Type | Default | Description |
|---|---|---|---|
| `storage` | `OtaStorage` | **required** | `{ getItem, setItem }` used to persist a stable install id. Wrap AsyncStorage, MMKV, or secure storage. |
| `appVersion` | `string` | **required** | Marketing/app version, used for `targetAppVersions` matching. |
| `autoCheckOnLaunch` | `boolean` | `true` | Silent background check when the provider mounts. |
| `autoStage` | `boolean` | `true` | When an update is found, download + native-verify + stage it automatically. |
| `autoMarkHealthyMs` | `number` | _off_ | Auto-promote the running bundle to last-known-good after N ms. Omit to keep it **manual** (safer — see [crash-loop](/docs/concepts/crash-loop)). |
| `checkOnAppForeground` | `boolean` | `false` | Re-run a check when the app returns to the foreground (via `AppState`). |
| `onStatusChange` | `(s: OtaStatus) => void` | — | Fires on every lifecycle status transition. |
| `getEnrollToken` | `() => Promise<string \| undefined>` | — | Returns your app session token, attached to `/enroll` so a device key can only be registered by an authenticated user. |
| `serverUrlOverride` | `string` | — | Override the native-embedded server URL (POC/testing only; prod URL must come from native). |
| `logger` | `OtaLogger` | `console` | `{ info, warn, error }`. |
| `transport` | `TransportSecurity` | no-op | Pluggable transport (TLS pinning) — see [pinning](/docs/security/pinning-attestation). |
| `attestor` | `IntegrityAttestor` | no-op | Pluggable attestation (Play Integrity / App Attest). |

### `OtaStorage`

```ts
interface OtaStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}
```

See [Storage adapters](/docs/react-native/storage) for AsyncStorage / MMKV / secure-storage examples.

## What the provider does on mount

1. Reads the current bundle meta from native.
2. Calls `getEnrollToken()` and **enrolls** the hardware device key (idempotent — re-registering
   the same public key is fine).
3. If `autoCheckOnLaunch` (default), runs a **device-key-signed** `/check`.
4. If `autoStage` (default) and an eligible update exists, downloads + natively verifies + stages
   it, then schedules apply-on-next-cold-start.
5. Reports any prior crash-loop failure to the backend exactly once.

:::tip Security comes from native
`serverUrlOverride` aside, the channel, server URL, public key, and runtimeVersion all come from
**native** (your build flavour). JS cannot change which key verifies a bundle.
:::

Next: [useOtaUpdate →](/docs/react-native/use-ota-update)
