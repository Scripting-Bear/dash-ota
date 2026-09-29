---
sidebar_position: 2
title: Android setup
---

# Android setup

Two changes in your Android project: add the dash-ota settings as Android resources, and make React
Native ask dash-ota which JavaScript bundle to load.

## 1. Add the settings

In `android/app/build.gradle`, add these lines inside `defaultConfig`. If you use product flavours,
put them in each flavour instead (see [Environments & flavours](/docs/react-native/environments)).

```groovy title="android/app/build.gradle"
android {
    defaultConfig {
        // your existing applicationId, versionCode, versionName, ...
        resValue "string",  "ota_channel",         "dev"
        resValue "string",  "ota_server_url",      "<YOUR_SERVER_URL>"
        resValue "string",  "ota_public_keys",     "<YOUR_PUBLIC_KEY>"
        resValue "string",  "ota_runtime_version", "rt1"
        resValue "integer", "ota_native_build",    "1"
    }
}
```

| Resource | What to put there |
|---|---|
| `ota_channel` | `dev`, `uat` or `prod`. It is compiled into the binary and JavaScript cannot change it. If unset, it is `dev`. |
| `ota_server_url` | Your backend's base URL, such as `https://ota.example.com`. From the Android emulator, `http://10.0.2.2:4455` reaches port 4455 on your computer; a release build needs step 3 to use plain HTTP. |
| `ota_public_keys` | The `publicKeyRawB64` value that [`dash-ota keygen`](/docs/cli/commands#keygen) prints. To trust several keys, separate them with commas; a release installs if any of them verifies it. |
| `ota_runtime_version` | The same string you pass to `--runtime-version` when you publish. A fixed label such as `rt1` is the simplest start. If unset, it is `embedded`. |
| `ota_native_build` | A whole number identifying this native build. If unset, it is `0`. |

The public key and runtime version decide which updates this binary accepts, so they come from the
binary and not from JavaScript.

:::warning[Change `ota_native_build` with every store build]
A downloaded update is only loaded by the native build it was downloaded on. When a new store build
changes `ota_native_build`, the device discards updates stored by the previous build and starts on
the new build's own JavaScript. If you ship a store build without changing it, and the runtime
version is also unchanged, the device keeps running the update it downloaded earlier on top of the
new binary. The simplest rule is to keep it equal to `versionCode` and bump both together. It is also
the number the [force-update gate](/docs/concepts/force-update) and `--min-native-build` compare
against.
:::

### Optional: TLS pinning for downloads

```groovy
resValue "string", "ota_tls_pins", "<YOUR_PIN_1>,<YOUR_PIN_2>"
```

Each pin is the base64-encoded SHA-256 of a certificate's full DER encoding (not the SPKI hash some
other tools use). Leaving it unset turns pinning off, which is the default. Pinning covers the update
file downloads only. The `/enroll`, `/check` and `/confirm` requests go through JavaScript `fetch`,
which is not pinned unless you pass a `transport` in the [provider config](/docs/react-native/provider-config).
In 0.5.1 and later, Android matches pins against the certificate chain the platform validated; before
0.5.1 it matched against the chain the server presented. See
[Pinning & attestation](/docs/security/pinning-attestation).

### The device key

Each install creates a signing key in the Android Keystore: in StrongBox where the device has it, and
in the TEE otherwise. At enrollment the device reports whether the key is hardware-backed as
`keyHardwareBacked`. The device reports that value about itself, and the backend has no way to prove
it. Emulators have no secure hardware and report `false`.

## 2. Wire the bundle loader

When the app starts, React Native asks which JavaScript bundle file to load.
`DashOtaBundleLoader.getBundleFile()` answers with the path of the downloaded update, or `null` when
there is none, in which case React Native loads the bundle packaged in the APK. The same call runs
the [crash-loop breaker](/docs/concepts/crash-loop), so React Native has to get the path from it.

Open `android/app/src/main/java/.../MainApplication.kt`. The change depends on which React Native
template generated the file:

- It has `override val reactHost: ReactHost by lazy { getDefaultReactHost(...) }` and no
  `DefaultReactNativeHost`: this is the React Native 0.82+ template. Use shape A.
- It has `override val reactNativeHost` set to `object : DefaultReactNativeHost(this) { ... }`: this
  is the React Native 0.79 to 0.81 template. Use shape B.

In both shapes, only the lines marked `// dash-ota` are new. Keep your own `package` line at the top
of the file, and leave the rest as your template generated it.

### Shape A: React Native 0.82 and later

Pass `jsBundleFilePath` to `getDefaultReactHost`:

```kotlin title="MainApplication.kt"
import android.app.Application
import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.ReactNativeApplicationEntryPoint.loadReactNative
import com.facebook.react.defaults.DefaultReactHost.getDefaultReactHost
import com.dashota.DashOtaBundleLoader // dash-ota

class MainApplication : Application(), ReactApplication {

  override val reactHost: ReactHost by lazy {
    getDefaultReactHost(
      context = applicationContext,
      packageList =
        PackageList(this).packages.apply {
          // Packages that cannot be autolinked yet can be added manually here, for example:
          // add(MyReactNativePackage())
        },
      jsBundleFilePath = DashOtaBundleLoader.getBundleFile(applicationContext), // dash-ota
    )
  }

  override fun onCreate() {
    super.onCreate()
    loadReactNative(this)
  }
}
```

This is the file a fresh React Native 0.87.1 app generates, with the two lines added; it was
tested in release builds.

### Shape B: React Native 0.79 to 0.81

Override `getJSBundleFile()` inside the `DefaultReactNativeHost` object, next to
`getJSMainModuleName()`. It has to be inside that object: placed directly in `MainApplication`, it
does not compile, because there is no `getJSBundleFile()` there to override.

```kotlin title="MainApplication.kt"
import android.app.Application
import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.ReactNativeHost
import com.facebook.react.ReactPackage
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.load
import com.facebook.react.defaults.DefaultReactHost.getDefaultReactHost
import com.facebook.react.defaults.DefaultReactNativeHost
import com.facebook.react.soloader.OpenSourceMergedSoMapping
import com.facebook.soloader.SoLoader
import com.dashota.DashOtaBundleLoader // dash-ota

class MainApplication : Application(), ReactApplication {

  override val reactNativeHost: ReactNativeHost =
      object : DefaultReactNativeHost(this) {
        override fun getPackages(): List<ReactPackage> =
            PackageList(this).packages.apply {
              // Packages that cannot be autolinked yet can be added manually here, for example:
              // add(MyReactNativePackage())
            }

        override fun getJSMainModuleName(): String = "index"

        override fun getUseDeveloperSupport(): Boolean = BuildConfig.DEBUG

        override fun getJSBundleFile(): String? = DashOtaBundleLoader.getBundleFile(applicationContext) // dash-ota

        override val isNewArchEnabled: Boolean = BuildConfig.IS_NEW_ARCHITECTURE_ENABLED
        override val isHermesEnabled: Boolean = BuildConfig.IS_HERMES_ENABLED
      }

  override val reactHost: ReactHost
    get() = getDefaultReactHost(applicationContext, reactNativeHost)

  override fun onCreate() {
    super.onCreate()
    SoLoader.init(this, OpenSourceMergedSoMapping)
    if (BuildConfig.IS_NEW_ARCHITECTURE_ENABLED) {
      load()
    }
  }
}
```

This is the React Native 0.79 template. Later templates differ in details such as the imports and
the `onCreate()` body; keep yours and add only the two marked lines.

React Native reads the bundle path several times per launch. `getBundleFile()` works out the answer
on the first call and returns the same value for the rest of the process, so each launch counts once.

## 3. Plain HTTP to a backend on your computer (optional)

Release builds block plain `http://` traffic, because React Native's Gradle plugin sets
`usesCleartextTraffic` to `false` for release. To test a release build against a backend running on
your computer, allow plain HTTP for the emulator's address and `localhost` only.

Create `android/app/src/main/res/xml/network_security_config.xml`:

```xml title="android/app/src/main/res/xml/network_security_config.xml"
<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
  <!-- Local development only: lets a release build reach a plain-HTTP backend on your machine. -->
  <domain-config cleartextTrafficPermitted="true">
    <domain includeSubdomains="false">10.0.2.2</domain>
    <domain includeSubdomains="false">localhost</domain>
  </domain-config>
</network-security-config>
```

Then add the `android:networkSecurityConfig` attribute to the existing `<application>` element in
`android/app/src/main/AndroidManifest.xml`, keeping its other attributes:

```xml title="android/app/src/main/AndroidManifest.xml"
<application
  android:name=".MainApplication"
  android:networkSecurityConfig="@xml/network_security_config">
```

Every other host still requires HTTPS. On a physical device, add your computer's LAN IP address as
another `<domain>`. Keep this file out of the builds you ship to users, and use HTTPS for any real
server.

## Native dependency

The library depends on `com.github.luben:zstd-jni`, pinned to 1.5.7-4, to decompress update files.
Gradle resolves it and there is nothing to configure. Two things matter if you ever override that
version:

- 1.5.6-9 and earlier ship `.so` files that are not 16 KB page-aligned on `armeabi-v7a`, `x86` and
  `x86_64`, which Google Play now rejects. 1.5.7-4 is aligned on all four ABIs.
- Later builds require `compileSdk 37`, and fail the build on a lower `compileSdk`.

## Several environments

For separate dev, uat and prod builds, define product flavours and give each its own
`ota_channel`, `ota_public_keys` and `ota_runtime_version`. See
[Environments & flavours](/docs/react-native/environments).

Next: [iOS setup →](/docs/react-native/ios-setup)
