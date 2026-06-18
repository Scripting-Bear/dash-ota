# React Native integration — `react-native-dash-ota`

The dash-ota client library. It orchestrates the OTA lifecycle in JS, but does all the
**trust-critical work in native** (Ed25519 signature verify, AES-256-GCM decrypt, per-file
SHA-256, atomic slot swap, crash-rollback) — *before* and independent of JS, so a compromised
bundle can't bypass it. Public API: one provider + one hook.

- **New Architecture** (TurboModule, codegen `DashOtaSpec`, native module `DashOta`)
- **Android** (Kotlin + Google Tink) · **iOS** (Obj-C++ + Swift CryptoKit)
- Per-device **hardware key** (AndroidKeyStore / iOS Secure Enclave) for request auth

---

## 1. Install

```bash
npm install react-native-dash-ota
cd ios && pod install   # iOS
```

Requirements: React Native **0.79+**, **New Architecture enabled**, Hermes.

---

## 2. Native build config (per flavour)

Channel, server URL, embedded Ed25519 public key(s), and `runtimeVersion` come from the
**native** side (per build flavour) so they can't be tampered from JS.

### Android — `resValue` string resources

In `android/app/build.gradle`, inject per build type / product flavor:

```gradle
resValue "string", "ota_channel",         "prod"
resValue "string", "ota_server_url",      "https://ota.yourapi.com"
resValue "string", "ota_public_keys",     "<base64 raw Ed25519 public key>"   // comma-separate for a key ring
resValue "string", "ota_runtime_version", "rt1"
resValue "integer","ota_native_build",    "42"
```

Wire the bundle loader so release builds load the active OTA slot (debug keeps Metro). In
`MainApplication.kt`:

```kotlin
import com.dashota.DashOtaBundleLoader

override fun getJSBundleFile(): String? = DashOtaBundleLoader.getBundleFile(applicationContext)
```

### iOS — Info.plist (`$(OTA_*)` from xcconfig)

Add to `Info.plist` (values supplied per Xcode config via `.xcconfig`):

```
OTA_CHANNEL          = $(OTA_CHANNEL)
OTA_SERVER_URL       = $(OTA_SERVER_URL)
OTA_PUBLIC_KEYS      = $(OTA_PUBLIC_KEYS)
OTA_RUNTIME_VERSION  = $(OTA_RUNTIME_VERSION)
```

In `AppDelegate.swift`, in the **release** branch only:

```swift
import DashOta
// in bundleURL():
#if DEBUG
  return RCTBundleURLProvider.sharedSettings().jsBundleURL(forBundleRoot: "index")
#else
  return DashOtaBundleLoader.bundleURL()
#endif
```

> Generate the `OTA_PUBLIC_KEYS` value with `dash-ota keygen` (the `publicKeyRawB64`). Each
> flavour embeds **its own** channel + signing public key, so an OTA can only reach the matching
> flavour and only if signed by that environment's key. See the [CLI guide](./cli.md).

---

## 3. Wrap your app

```tsx
import { DashOtaProvider, useOtaUpdate } from 'react-native-dash-ota';
import type { OtaConfig } from 'react-native-dash-ota';

const config: OtaConfig = {
  appVersion: '1.4.0',
  storage,                                    // your AsyncStorage / secure-storage adapter
  getEnrollToken: () => auth.getSessionToken(), // ties the device key to a real user session
  autoCheckOnLaunch: true,                     // silent check on launch (default)
  autoStage: true,                             // download + stage when an update is found (default)
  checkOnAppForeground: true,                  // re-check when the app returns to foreground
  onStatusChange: (s) => log('[ota]', s),
  // autoMarkHealthyMs: 4000,                  // optional auto-promote; prefer manual markHealthy()
};

export default function Root() {
  return (
    <DashOtaProvider config={config}>
      <App />
    </DashOtaProvider>
  );
}
```

### `OtaConfig`

| Field | Default | Meaning |
|---|---|---|
| `storage` | — (required) | `{ getItem, setItem }` for the stable install id |
| `appVersion` | — (required) | marketing version, for `targetAppVersions` matching |
| `autoCheckOnLaunch` | `true` | silent background check on mount |
| `autoStage` | `true` | download + native-verify + stage when an update is found |
| `autoMarkHealthyMs` | _off_ | auto-promote to last-known-good after N ms (opt-in) |
| `checkOnAppForeground` | `false` | re-check when app returns to foreground |
| `onStatusChange` | — | callback on every lifecycle status transition |
| `getEnrollToken` | — | returns the app session token attached to `/enroll` |
| `serverUrlOverride` | — | POC/testing only (prod URL comes from native) |
| `logger` | console | `{ info, warn, error }` |
| `transport` | no-op | `TransportSecurity` plug-in (TLS pinning, later) |
| `attestor` | no-op | `IntegrityAttestor` plug-in (Play Integrity / App Attest, later) |

---

## 4. Drive it from a screen

```tsx
function UpdateBadge() {
  const ota = useOtaUpdate();
  // ota.status: 'idle' | 'checking' | 'downloading' | 'staged' | 'apply-pending' | 'up-to-date' | 'error'
  // ota.currentBundle, ota.availableUpdate, ota.isMandatory, ota.nativePolicy, ota.progress, ota.error

  useEffect(() => {
    // Call AFTER the app is genuinely usable (first real screen post-auth), NOT just when JS loads —
    // a bundle that white-screens must still count as unhealthy for the crash-loop breaker.
    ota.markHealthy();
  }, []);

  return (
    <>
      <Button title="Check now" onPress={ota.checkNow} />
      {ota.availableUpdate && <Button title="Apply & restart" onPress={() => ota.applyUpdate(true)} />}
      <Button title="Roll back" onPress={ota.rollback} />
    </>
  );
}
```

`useOtaUpdate()` returns: `{ status, channel, currentBundle, availableUpdate, isMandatory,
nativePolicy, progress, error, checkNow, applyUpdate, markHealthy, rollback }`.

---

## Lifecycle & guarantees

```
enroll (once, device key) → check → [eligible?] → download (one-time token)
   → NATIVE: Ed25519 verify → AES-GCM decrypt → per-file SHA-256 → stage
   → apply on next cold start → app boots → markHealthy() → confirm(healthy)
   (crash N× without markHealthy → revert to last-known-good → embedded; disable bad bundle; report)
```

- **Apply on next cold start** (never hot-swap mid-session).
- **Crash-loop breaker** reverts a bad bundle to last-known-good, then the embedded bundle; the
  bad bundle is disabled and reported to the backend (drives server auto-pause).
- **runtimeVersion gate**: an OTA built for a new native binary can never land on an older one
  (enforced in native *and* on the backend).
- **Downgrade guard**: native rejects an older `bundleVersion`.
- **Fail-closed**: any verify/decrypt/hash error keeps the last-known-good/embedded bundle.

### Mandatory & force-update

- A release flagged `mandatory` → show a blocking "reopen the app" prompt (don't bet on an
  in-process restart under bridgeless).
- `useOtaUpdate().nativePolicy` carries the **force-update gate**: when the device's native build
  is below `minSupportedNativeVersion`, `severity` is `hard` (blocking "update from store", use
  `storeUrl`) or `soft` (dismissible nudge).

---

## Notes

- Native module: `DashOta` (TurboModule), package `com.dashota`, podspec `DashOta`.
- The example app under `packages/rn/example` (`DashOtaExample`) demonstrates the full loop with
  dev/uat/prod flavours; see the [CLI guide](./cli.md) and `packages/rn/example/scripts/publish-ota.mjs`.
- Pinning (`TransportSecurity`) and attestation (`IntegrityAttestor`) are modular plug-ins the
  core doesn't depend on — inject them when ready.
