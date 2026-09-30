---
sidebar_position: 1
title: Installation
---

# Installation

Install the client library in your app, and the CLI as a dev dependency of the same project:

```bash
npm install react-native-dash-ota
npm install --save-dev @dash-ota/cli
cd ios && pod install && cd ..
```

The CLI's npm package is `@dash-ota/cli`, and the command it installs is called `dash-ota`. Once it
is a dev dependency, `npx dash-ota <command>` run from the project folder uses that local copy, at
the version your lockfile pins. Outside a project, `npx dash-ota` still works: the small `dash-ota`
package on npm downloads the CLI and runs it.

## Requirements

- React Native 0.79 or later. The package's `peerDependencies` require `react-native >= 0.79.0`,
  and it has been tested up to 0.87.1.
- The New Architecture. dash-ota is a TurboModule and has no fallback for the old bridge.
- Hermes, React Native's default JavaScript engine. Updates are shipped as Hermes bytecode.
- Node 20.19.0 or later for the CLI.

Autolinking registers the native module on both platforms. You don't add a package to
`MainApplication`, change the Podfile, or write a ProGuard rule: the keep rule the Android
decompressor needs ships with the library.

npm 11 prints a warning about install scripts for `@mongodb-js/zstd`, a native module the CLI uses to
compress bundles. The install still works. If a later npm version blocks the script instead, allow it
with `npm install-scripts approve @mongodb-js/zstd`.

## What you set up next

1. Native config for each build flavour: the channel, the server URL, the public key(s), the runtime
   version and the native build number. They are compiled into the binary so JavaScript cannot
   change them. See [Android setup](/docs/react-native/android-setup) and
   [iOS setup](/docs/react-native/ios-setup).
2. The bundle loader, so that a release build starts from a downloaded update when it has one. Both
   setup pages cover it. Debug builds keep loading JavaScript from Metro, so an update never applies
   to a debug build.
3. The provider: wrap your app in [`<DashOtaProvider>`](/docs/react-native/provider-config).

## Check that it works

Run a release build on an Android emulator or device and watch the log:

```bash
adb logcat -s DashOta:W ReactNativeJS:I
```

On the first launch, once the backend URL and public key are set up, you should see:

```
launch: no stored bundle — using the embedded one
[dash-ota] enrolled device key
```

The first line comes from native code, under the `DashOta` tag on Android and the `dash-ota` log
subsystem on iOS. The second comes from the provider's default logger, which writes through
`console`. It shows up under the `ReactNativeJS` tag on Android and the `com.facebook.react.log`
subsystem on iOS, not under `DashOta`. React Native keeps `console` output in release builds unless
your app removes it, for example with a Babel plugin that strips `console.*` calls. The enroll line
only appears on the launch that enrolls; later launches skip enrollment.
[Troubleshooting](/docs/react-native/troubleshooting#reading-logs) has the iOS command.

:::note[New Architecture]
dash-ota is a TurboModule: codegen spec `DashOtaSpec`, native module name `DashOta`, Android package
`com.dashota`.
:::

Next: [Android setup →](/docs/react-native/android-setup)
