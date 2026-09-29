---
sidebar_position: 3
title: iOS setup
---

# iOS setup

Two changes in your iOS project: add the dash-ota settings to `Info.plist`, and make React Native ask
dash-ota which JavaScript bundle to load.

## 1. Add the settings to Info.plist

Add these keys to `ios/<YourApp>/Info.plist`, inside the top-level `<dict>`. The values below are for
a first run against a backend on your computer from the iOS simulator:

```xml title="Info.plist"
<key>OTA_CHANNEL</key>
<string>dev</string>
<key>OTA_SERVER_URL</key>
<string>http://localhost:4455</string>
<key>OTA_PUBLIC_KEYS</key>
<string>YOUR_PUBLIC_KEY</string>
<key>OTA_RUNTIME_VERSION</key>
<string>rt1</string>
```

Replace `YOUR_PUBLIC_KEY` with the `publicKeyRawB64` value that
[`dash-ota keygen`](/docs/cli/commands#keygen) prints.

| Key | What to put there |
|---|---|
| `OTA_CHANNEL` | `dev`, `uat` or `prod`. It is compiled into the binary and JavaScript cannot change it. If missing, it is `dev`. |
| `OTA_SERVER_URL` | Your backend's base URL, such as `https://ota.example.com`. |
| `OTA_PUBLIC_KEYS` | One or more `publicKeyRawB64` values, separated by commas. A release installs if any of them verifies it. |
| `OTA_RUNTIME_VERSION` | The same string you pass to `--runtime-version` when you publish. If missing, it is `embedded`. |

The native build number is not a separate key. dash-ota reads `CFBundleVersion`, the Build number in
Xcode's General tab, and it must be a whole number: a value such as `1.0.3` is read as `0`. There is no
`OTA_NATIVE_BUILD` key.

:::warning[Change the build number with every store build]
A downloaded update is only loaded by the native build it was downloaded on. When a new store build
has a new `CFBundleVersion`, the device discards updates stored by the previous build and starts on
the new build's own JavaScript. If the build number and runtime version both stay the same, the
device keeps running the update it downloaded earlier on top of the new binary. It is also the number
the [force-update gate](/docs/concepts/force-update) and `--min-native-build` compare against.
:::

### Different values per build configuration

To give each build configuration its own values, reference build settings from `Info.plist` and set
them in an `.xcconfig` file per configuration:

```xml title="Info.plist"
<key>OTA_CHANNEL</key>
<string>$(OTA_CHANNEL)</string>
<key>OTA_SERVER_URL</key>
<string>$(OTA_SERVER_URL)</string>
<key>OTA_PUBLIC_KEYS</key>
<string>$(OTA_PUBLIC_KEYS)</string>
<key>OTA_RUNTIME_VERSION</key>
<string>$(OTA_RUNTIME_VERSION)</string>
```

```ini title="Config/App.Prod.xcconfig"
OTA_CHANNEL = prod
OTA_SERVER_URL = https:/$()/<YOUR_PROD_SERVER_HOST>
OTA_PUBLIC_KEYS = <YOUR_PROD_PUBLIC_KEY>
OTA_RUNTIME_VERSION = rt1
```

:::caution[`//` starts a comment in xcconfig]
Write URLs as `https:/$()/host`. The empty `$()` splits the `//` so Xcode does not read the rest of
the line as a comment.
:::

React Native projects use CocoaPods, which sets its own generated xcconfig as each configuration's
base configuration. If you set yours as the base configuration instead, `#include` the Pods xcconfig
for that configuration at the top of your file, or the Pods build settings stop applying.

### Optional keys

```xml title="Info.plist"
<key>OTA_TLS_PINS</key>
<string>YOUR_PIN_1,YOUR_PIN_2</string>
<key>OTA_REQUIRE_HARDWARE_KEY</key>
<string>true</string>
```

`OTA_TLS_PINS` turns on certificate pinning for update file downloads. Replace the values with
base64-encoded SHA-256 hashes of certificates' full DER encoding (not SPKI hashes). Pinning is off
when the key is missing or empty. It covers the file downloads only: `/enroll`, `/check` and
`/confirm` go through JavaScript `fetch`, which is not pinned unless you pass a `transport` in the
[provider config](/docs/react-native/provider-config). See
[Pinning & attestation](/docs/security/pinning-attestation).

Each install creates its signing key in the Secure Enclave when one is available. By default, if the
Secure Enclave cannot create the key, dash-ota falls back to a software key in the keychain. With
`OTA_REQUIRE_HARDWARE_KEY` set to `true`, a device without a usable Secure Enclave has no device key
instead, so it cannot enroll and gets no updates. The simulator has no Secure Enclave and always uses
a software key, whatever this setting says. The device reports whether its key is hardware-backed as
`keyHardwareBacked` at enrollment; the backend has no way to prove that value.

## 2. Wire the bundle URL

Open `ios/<YourApp>/AppDelegate.swift`. Every React Native version dash-ota supports (0.79 and later)
generates a `ReactNativeDelegate` class there, a subclass of `RCTDefaultReactNativeFactoryDelegate`.
Add `import DashOta` at the top of the file and change the release branch of its `bundleURL()`:

```swift title="AppDelegate.swift"
import DashOta // dash-ota, next to the existing imports

class ReactNativeDelegate: RCTDefaultReactNativeFactoryDelegate {
  override func sourceURL(for bridge: RCTBridge) -> URL? {
    self.bundleURL()
  }

  override func bundleURL() -> URL? {
#if DEBUG
    RCTBundleURLProvider.sharedSettings().jsBundleURL(forBundleRoot: "index")
#else
    DashOtaBundleLoader.bundleURL() ?? Bundle.main.url(forResource: "main", withExtension: "jsbundle") // dash-ota
#endif
  }
}
```

`DashOtaBundleLoader.bundleURL()` returns the downloaded update, or `nil` when there is none. The
`?? Bundle.main.url(...)` part then loads the bundle packaged in the app. Keep it: without it, a
release build that has no update installed has no JavaScript to load. The call also runs the
[crash-loop breaker](/docs/concepts/crash-loop). Debug builds keep loading from Metro, so an update
never applies to a debug build.

This is the delegate a fresh React Native 0.87.1 app generates, with the release line changed; it was
tested in release builds.

## 3. Plain HTTP to a backend on your computer

The React Native iOS template sets `NSAllowsLocalNetworking` under `NSAppTransportSecurity` in
`Info.plist`, so a release build in the simulator can reach `http://localhost:4455` without further
changes. Use HTTPS for any real server.

## Several environments

For dev, uat and prod builds, create a build configuration and a scheme for each (for example
`Release-Dev` and `Release-Prod`), each with its own `.xcconfig`. See
[Environments & flavours](/docs/react-native/environments).

## CocoaPods

dash-ota ships as the `DashOta` pod, and `pod install` picks it up through autolinking. The
Objective-C++ part imports the generated Swift header behind a
`#if __has_include(<DashOta/DashOta-Swift.h>)` check, so it builds with static libraries and with
frameworks.

## The bundled zstd

Update files are compressed with zstd on both platforms, and Apple's Compression framework has no
zstd. The pod therefore compiles zstd's official decompression-only source, pinned to 1.5.7 to match
Android's `zstd-jni`. There is no extra pod to add.

Its symbols are renamed to `DashOtaZ_*` at compile time. If your app links its own libzstd, the two
copies would otherwise share the same global `ZSTD_*` names, and because pods usually link statically,
Apple's linker does not always report that as a duplicate symbol: it can silently bind one copy's
calls to the other. With the rename, both copies can live in one binary. There is nothing for you to
do; this explains the unfamiliar names if you see them in a crash report.

Next: [Environments & flavours →](/docs/react-native/environments)
