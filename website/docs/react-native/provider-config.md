---
sidebar_position: 5
title: Provider & config
description: DashOtaProvider and every OtaConfig option.
---

# Provider & config

Wrap your app once in `<DashOtaProvider>`. It enrolls the device with your backend, checks for
updates, and exposes the state through [`useOtaUpdate()`](/docs/react-native/use-ota-update).

```tsx title="index.tsx or your root component"
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import { DashOtaProvider, type OtaConfig } from 'react-native-dash-ota';
import App from './App';

// Replace with your auth code: resolve to the signed-in user's session token.
async function getSessionToken(): Promise<string | undefined> {
  return '<YOUR_SESSION_TOKEN>';
}

const config: OtaConfig = {
  appVersion: '1.4.0',
  storage: AsyncStorage,
  storeUrl: Platform.select({
    ios: 'https://apps.apple.com/app/id<YOUR_APP_STORE_ID>',
    default: 'market://details?id=<YOUR_APPLICATION_ID>',
  }),
  getEnrollToken: getSessionToken,
  checkOnAppForeground: true,
  onStatusChange: (status) => console.log('OTA status:', status),
};

export default function Root() {
  return (
    <DashOtaProvider config={config}>
      <App />
    </DashOtaProvider>
  );
}
```

Define `config` outside the component, as above, so it is not rebuilt on every render. The example
uses `@react-native-async-storage/async-storage` for `storage`; see
[Storage adapters](/docs/react-native/storage) for other options.

## `OtaConfig` reference

| Field | Type | Default | Description |
|---|---|---|---|
| `storage` | `OtaStorage` | required | `{ getItem, setItem }`, used to keep a stable install id. AsyncStorage can be passed as it is. |
| `appVersion` | `string` | required | Your app's version as users see it (Android `versionName`, iOS `CFBundleShortVersionString`). Releases published with `--target-app-versions` are matched against it. |
| `enabled` | `boolean` | `true` | `false` stops all OTA activity from JavaScript: no enroll, check, download or apply, and `status` is `disabled`. Use it to keep a device you don't trust (a rooted or jailbroken one, for example) off new updates. It does not remove an update that is already installed: native code still loads that at launch. |
| `autoCheckOnLaunch` | `boolean` | `true` | Check for an update when the provider mounts. |
| `autoStage` | `boolean` | `true` | When a check finds an update, download, verify and stage it straight away. With `false`, the check stops at status `update-available` and nothing downloads until you call `downloadUpdate()` or `ui.action()`. |
| `mandatory` | `'auto-download' \| 'announce'` | `'auto-download'` | What to do with a release published with `--mandatory`. `'auto-download'` downloads it even when `autoStage` is `false`. `'announce'` treats it like any other update; only `ui.blocking` marks it as required. |
| `uiCopy` | partial `OtaUiCopy` | built-in English | Replace any of the strings in `ui`. See [below](#uicopy). |
| `autoMarkHealthyMs` | `number` | not set | Call `markHealthy()` this many milliseconds after the provider mounts. When not set, you call `markHealthy()` yourself, which is safer; see [markHealthy](/docs/react-native/mark-healthy). |
| `checkOnAppForeground` | `boolean` | `false` | Check again each time the app returns to the foreground (via `AppState`). |
| `onStatusChange` | `(status: OtaStatus) => void` | none | Called on every change of `status`. |
| `storeUrl` | `string` | none | Your store listing, used as `nativePolicy.storeUrl` by the [force-update gate](/docs/concepts/force-update). The client never uses a store URL from the server, because the policy is not signed, so without this the gate has no link. It must start with `https://`, `market://` or `itms-apps://`; any other value is dropped and logged as an error. |
| `getEnrollToken` | `() => Promise<string \| undefined>` | none | Returns the signed-in user's session token. It is sent with `/enroll`, and the backend's `verifyEnrollToken` hook decides whether to accept it. Without that hook the backend only checks that a token is present. Called only when the device enrolls, which is normally once per install. |
| `serverUrlOverride` | `string` | none | Replaces the server URL from the native config. For tests and local development: it lets JavaScript change where requests go, so a production build should take the URL from native config. It does not change which key verifies a release. |
| `logger` | `OtaLogger` | `consoleLogger` | `{ info, warn, error }`. The default prefixes each message with `[dash-ota]` and writes it with `console.log`, `console.warn` and `console.error`. |
| `transport` | `TransportSecurity` | platform `fetch` | `{ fetch }` used for `/enroll`, `/check` and `/confirm`. Supply one to add TLS pinning to those requests; the default is not pinned. Native file downloads do not go through it. See [Pinning & attestation](/docs/security/pinning-attestation). |
| `attestor` | `IntegrityAttestor` | none | `{ getAttestationToken }`. Its token is sent with `/enroll` for your `verifyEnrollToken` hook to check (Play Integrity or App Attest, for example). The token is not bound to a challenge from the server. |

### `uiCopy`

`ui` comes with plain English wording for each phase:

| Phase | `title` | `description` | `cta` |
|---|---|---|---|
| `available` | `Update available` | `Version {version} is ready to download.` | `Download` |
| `working` | `Downloading update` | `Keep the app open while the update downloads.` | none |
| `ready` | `Restart to finish` | `Version {version} is ready to apply.` | `Restart now` |
| `error` | `Update didn't finish` | `Something went wrong. You can try again.` | `Try again` |

Override any string, per phase. Anything you leave out keeps the built-in text, and the first
`{version}` in each string is replaced with the update's bundle version:

```ts
import type { OtaConfig } from 'react-native-dash-ota';

const uiCopy: OtaConfig['uiCopy'] = {
  ready: { title: 'Restart to finish updating', cta: 'Restart now' },
  error: { description: 'The update could not be installed. Try again later.' },
};
```

Pass it as `uiCopy` in your config. The built-in strings are exported as `DEFAULT_UI_COPY`.

### `OtaStorage`

```ts
interface OtaStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}
```

The provider stores two keys: `dash-ota.installId` and `dash-ota.enrolled` (exported as
`STORAGE_KEYS`). See [Storage adapters](/docs/react-native/storage).

## What the provider does on mount

1. Reads the running bundle's details from native code.
2. If `enabled` is `false`, sets `status` to `disabled` and stops.
3. If `autoCheckOnLaunch` is on (the default), enrolls the device if it has not enrolled yet. That
   calls `getEnrollToken()` and your `attestor`, and sends the device's public key to `/enroll`.
   Later launches skip this step.
4. Sends a `/check` request, signed with the device key.
5. Reports to the backend, once each, a crash-loop revert from an earlier launch and an update
   applied on this launch.
6. If the check offered an update and `autoStage` is on, or the update is mandatory and `mandatory` is
   `'auto-download'`: downloads it, has native code verify it, stages it, and sets it to apply on the
   next cold start.

If any step fails, `status` becomes `error`, `error` holds the message, and the app keeps running
the bundle it started with.

:::tip[The native config decides what is trusted]
The channel, public keys and runtime version come from the binary. JavaScript can read the channel
but cannot change any of them, and `serverUrlOverride` only changes where requests go. Whatever the
server returns, native code installs only releases signed by a key compiled into the binary.
:::

Next: [useOtaUpdate →](/docs/react-native/use-ota-update)
