---
sidebar_position: 3
title: iOS setup
---

# iOS setup

Embed the per-flavour OTA config in **Info.plist** (driven by `.xcconfig`), and wire the bundle URL.

## 1. Info.plist + xcconfig

Add to `Info.plist`, with values supplied per Xcode configuration via `.xcconfig`:

```xml
<key>OTA_CHANNEL</key>          <string>$(OTA_CHANNEL)</string>
<key>OTA_SERVER_URL</key>       <string>$(OTA_SERVER_URL)</string>
<key>OTA_PUBLIC_KEYS</key>      <string>$(OTA_PUBLIC_KEYS)</string>
<key>OTA_RUNTIME_VERSION</key>  <string>$(OTA_RUNTIME_VERSION)</string>
```

```ini title="Config/App.Prod.xcconfig"
OTA_CHANNEL = prod
OTA_SERVER_URL = https:/$()/ota.yourapi.com
OTA_PUBLIC_KEYS = BASE64_RAW_ED25519_PUBLIC_KEY
OTA_RUNTIME_VERSION = rt1
```

:::caution `//` is a comment in xcconfig
Write URLs as `https:/$()/host` — the empty `$()` interpolation breaks up the `//` so it isn't
treated as a comment. The native `DashOtaConfig` reads `OTA_*` from `Bundle.main`.
:::

## 2. Wire the bundle URL

In `AppDelegate.swift`, in the **release** branch only:

```swift
import DashOta

func bundleURL() -> URL? {
  #if DEBUG
    return RCTBundleURLProvider.sharedSettings().jsBundleURL(forBundleRoot: "index")
  #else
    return DashOtaBundleLoader.bundleURL()  // active OTA slot, or embedded fallback
  #endif
}
```

## 3. Local dev networking

`NSAllowsLocalNetworking` (or an ATS exception) lets the simulator reach `http://localhost:4455`.
Production stays HTTPS.

## Build configs & schemes

For dev/uat/prod, create Xcode configurations (`Debug/Release-{Dev,UAT,Prod}`) + schemes, each
pointing at the matching `.xcconfig`. The Podfile's `post_install` can map the ENVFILE per config.
See [Environments & flavours](/docs/react-native/environments).

## Pods note

dash-ota ships as a static-lib pod (`DashOta`). The Obj-C++ bridge imports the Swift header via a
`#if __has_include(<DashOta/DashOta-Swift.h>)` guard so it builds under the default static linkage.

Next: [Environments & flavours →](/docs/react-native/environments)
