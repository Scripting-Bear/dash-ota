---
sidebar_position: 1
title: Installation
---

# Installation

```bash
npm install react-native-dash-ota
# or: yarn add react-native-dash-ota
cd ios && pod install
```

Requirements: **React Native 0.79+**, **New Architecture enabled**, **Hermes**. Autolinking wires
the native `DashOta` TurboModule on both platforms.

## What you'll set up

1. **Native per-flavour config** — channel, server URL, embedded Ed25519 public key(s), and
   `runtimeVersion`, supplied per build flavour so they can't be tampered from JS:
   - [Android setup](/docs/react-native/android-setup)
   - [iOS setup](/docs/react-native/ios-setup)
2. **The bundle-loader hook** — so release builds boot from the active OTA slot (debug keeps Metro).
3. **The provider** — wrap your app in [`<DashOtaProvider>`](/docs/react-native/provider-config).

## Verify the native module

After install + pod install, the `DashOta` module should be available. In a release build, the
provider will log `[dash-ota] enrolled device key` on first launch once the server URL + public
key are wired.

:::note New Architecture
dash-ota is a TurboModule (codegen spec `DashOtaSpec`, native module name `DashOta`, Android
package `com.dashota`). It requires the New Architecture — there is no old-bridge fallback.
:::

Next: [Android setup →](/docs/react-native/android-setup)
