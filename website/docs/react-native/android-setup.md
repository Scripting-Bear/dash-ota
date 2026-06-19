---
sidebar_position: 2
title: Android setup
---

# Android setup

Embed the per-flavour OTA config as **string/integer resources**, and wire the bundle loader.

## 1. Inject config via `resValue`

In `android/app/build.gradle`, per build type or product flavour:

```groovy
resValue "string",  "ota_channel",         "prod"
resValue "string",  "ota_server_url",      "https://ota.yourapi.com"
resValue "string",  "ota_public_keys",     "BASE64_RAW_ED25519_PUBLIC_KEY"  // comma-separate for a key ring
resValue "string",  "ota_runtime_version", "rt1"
resValue "integer", "ota_native_build",    "42"
```

The native `DashOtaConfig` reads these by name (`ota_channel`, `ota_server_url`,
`ota_public_keys`, `ota_runtime_version`, `ota_native_build`). The **public key + runtimeVersion
are security-relevant**, which is exactly why they live in native, not JS.

> Generate `ota_public_keys` with [`dash-ota keygen`](/docs/cli/overview) (the `publicKeyRawB64`).

## 2. Wire the bundle loader

Release builds must boot from the active OTA slot; debug keeps Metro. In `MainApplication.kt`:

```kotlin
import com.dashota.DashOtaBundleLoader

override fun getJSBundleFile(): String? =
  DashOtaBundleLoader.getBundleFile(applicationContext)
```

`getBundleFile` returns the staged/current slot path, or `null` to fall back to the embedded
`index.android.bundle`.

## 3. Cleartext for local dev (optional)

To talk to a local backend over HTTP (`http://10.0.2.2:4455` from the emulator), allow cleartext
**for the dev flavour only** via a `network_security_config.xml` and reference it from the
manifest. Production should stay HTTPS.

## Multi-flavour

For real dev/uat/prod isolation, define product flavours and inject a different
`ota_channel` / `ota_public_keys` / `ota_runtime_version` per flavour. See
[Environments & flavours](/docs/react-native/environments) for the full pattern (the example app
loads them from `.env.{dev,uat,prod}`).

Next: [iOS setup →](/docs/react-native/ios-setup)
