---
sidebar_position: 5
title: TurboModule & codegen
---

# TurboModule & codegen

dash-ota's native layer is a **New Architecture TurboModule**. This is what lets JS call into the
trust-critical native code with type-safe codegen bindings.

## Identifiers

| Thing | Value |
|---|---|
| Native module name | `DashOta` (`TurboModuleRegistry.getEnforcing('DashOta')`) |
| Codegen spec | `DashOtaSpec` |
| Android package | `com.dashota` |
| iOS podspec | `DashOta` |

## The spec surface

The TypeScript spec (`NativeDashOta.ts`) declares the native methods codegen generates bindings for:

- **Embedded config (sync):** `getRuntimeVersion`, `getChannel`, `getServerUrl`, `getPublicKeysB64`,
  `getNativeBuildNumber`.
- **State (promise):** `getCurrentBundleMeta`, `getState`.
- **Apply pipeline:** `downloadAndStage`, `applyOnNextLaunch`, `markHealthy`, `rollback`, `restart`,
  `isBundleDisabled`, `consumeFailedReport`.
- **Device identity (sync):** `getDevicePublicKeyB64`, `signWithDeviceKey`, `sha256Hex`.

The heavy work (`downloadAndStage`) runs **off the JS thread** so the multi-MB download + verify +
decrypt never blocks the UI.

## Bundle-loader hooks

Separately from the TurboModule, plain static native helpers (`DashOtaBundleLoader.getBundleFile()` /
`.bundleURL()`) are called from `MainApplication` / `AppDelegate` **before** React starts — they pick
which bundle the app boots from. These can't be TurboModule calls because they run before the JS
runtime exists.

## Why New Architecture only

dash-ota uses codegen + sync methods (e.g. `getDevicePublicKeyB64`) that require the New
Architecture / TurboModule infrastructure. There is no old-bridge fallback.

→ [Native vs JS trust split](/docs/concepts/native-vs-js)
