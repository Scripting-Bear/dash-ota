---
sidebar_position: 4
title: Environments & flavours
description: Wire dev, uat and prod so each build embeds its own channel, signing key and runtime version.
---

# Environments & flavours

dash-ota takes its environment from your build flavour. Each flavour's binary contains its own
channel, public key and runtime version, with two effects:

- A `dev` build is only offered releases published to the `dev` channel. In 0.5.1 and later, native
  code also refuses a release whose signed manifest names another channel.
- A release signed with another environment's key fails verification on the device and is never
  installed.

You use the dev, uat and prod flavours your app already has; there is no separate OTA environment
setting.

## The values in each build

| Android resource | iOS Info.plist key | Example | Meaning |
|---|---|---|---|
| `ota_channel` | `OTA_CHANNEL` | `prod` | The release channel: `dev`, `uat` or `prod`. |
| `ota_server_url` | `OTA_SERVER_URL` | `https://ota.example.com` | The backend's base URL. |
| `ota_public_keys` | `OTA_PUBLIC_KEYS` | the `publicKeyRawB64` from keygen | Ed25519 public key(s), separated by commas. |
| `ota_runtime_version` | `OTA_RUNTIME_VERSION` | `rt1` | Which native build an update is compatible with. Must equal `--runtime-version` when you publish. |
| `ota_native_build` (an integer resource) | `CFBundleVersion` | `42` | The native build number. Change it with every store build. On iOS it must be a whole number (`1.0.3` is read as `0`); there is no `OTA_NATIVE_BUILD` key. |

## One key pair per environment

Run keygen once per environment, from your app project with `@dash-ota/cli` installed as a dev
dependency (see [Installation](/docs/react-native/installation)):

```bash
npx dash-ota keygen --key-id key_dev_1
npx dash-ota keygen --key-id key_uat_1
npx dash-ota keygen --key-id key_prod_1
```

Each run writes `<id>.private.pem`, `<id>.public.pem`, `<id>.public.json` and `<id>.content.key` to
`.keys/` in the current folder, and prints a `publicKeyRawB64`. Put each environment's
`publicKeyRawB64` in that environment's build only. Add `.keys/` to `.gitignore`: the private keys
belong in your CI secrets, never in the repository or the app. [keygen](/docs/cli/commands#keygen)
covers the passphrase prompt and the flags.

Register each public key with the backend that serves that environment. The command needs the
backend's admin token in the `OTA_ADMIN_TOKEN` environment variable:

```bash
npx dash-ota register-key --key-id key_prod_1 --key-file .keys/key_prod_1.public.json \
  --server <YOUR_PROD_SERVER_URL>
```

A prod build contains only the prod public key, so a release signed with the dev key fails on prod
devices with `manifest signature did not verify`, and a leaked dev key cannot sign anything a prod
install accepts.

`--key-id` at publish time picks which private key signs the release. The manifest records that key
id, but the device does not use it to choose a key: it tries every public key compiled into the
binary, and the release installs if any of them verifies it.

## Publishing to one environment

Bundle the JavaScript, then publish it to the environment's channel with its key:

```bash
npx dash-ota bundle --platform android --out ./ota-out --hermes
npx dash-ota publish --bundle-dir ./ota-out --app-id <YOUR_APP_ID> --platform android \
  --channel uat --runtime-version rt1 --bundle-version 2 --key-id key_uat_1 \
  --server <YOUR_UAT_SERVER_URL>
```

- `--app-id` must be exactly the app's Android `applicationId`, including any `applicationIdSuffix`
  the flavour adds, or its iOS bundle identifier. A mismatch is refused on the device with
  `manifest is for a different app` (Android) or `manifest was built for a different app` (iOS).
- `--runtime-version` must equal the `ota_runtime_version` / `OTA_RUNTIME_VERSION` in that build.
- `--bundle-version` must be higher than the version the device is running. The embedded bundle
  counts as `0`.
- If the private key is encrypted, set `OTA_KEY_PASSPHRASE` or pass `--passphrase`.

See [publish](/docs/cli/commands#publish) for every flag and its default.

## Android: product flavours

```groovy title="android/app/build.gradle"
android {
    flavorDimensions "env"
    productFlavors {
        dev {
            dimension "env"
            applicationIdSuffix ".dev"
            resValue "string",  "ota_channel",         "dev"
            resValue "string",  "ota_server_url",      "<YOUR_DEV_SERVER_URL>"
            resValue "string",  "ota_public_keys",     "<YOUR_DEV_PUBLIC_KEY>"
            resValue "string",  "ota_runtime_version", "rt1"
            resValue "integer", "ota_native_build",    "42"
        }
        prod {
            dimension "env"
            resValue "string",  "ota_channel",         "prod"
            resValue "string",  "ota_server_url",      "<YOUR_PROD_SERVER_URL>"
            resValue "string",  "ota_public_keys",     "<YOUR_PROD_PUBLIC_KEY>"
            resValue "string",  "ota_runtime_version", "rt1"
            resValue "integer", "ota_native_build",    "42"
        }
    }
}
```

`applicationIdSuffix` lets the dev and prod apps sit side by side on one device. It also changes the
app id: with the example above, dev releases are published with `--app-id <YOUR_APPLICATION_ID>.dev`.

The example app in `packages/rn/example` fills these resources from `.env.dev`, `.env.uat` and
`.env.prod` files with a small Gradle function. The library only reads the compiled resources, so any
way of setting them works.

## iOS: one build configuration per environment

Create a build configuration and a scheme per environment (for example `Release-Dev` and
`Release-Prod`). Give each configuration an `.xcconfig` that sets `OTA_CHANNEL`, `OTA_SERVER_URL`,
`OTA_PUBLIC_KEYS` and `OTA_RUNTIME_VERSION`, and have `Info.plist` read them as `$(OTA_CHANNEL)` and so
on. [iOS setup](/docs/react-native/ios-setup#different-values-per-build-configuration) shows the files.

## Reading the channel in JavaScript

```tsx
import { Text } from 'react-native';
import { useOtaUpdate } from 'react-native-dash-ota';

export function ChannelLabel() {
  const { channel } = useOtaUpdate(); // 'dev', 'uat' or 'prod', read from the binary
  return <Text>{channel}</Text>;
}
```

JavaScript can read the channel but cannot change it.

→ [Android setup](/docs/react-native/android-setup) · [iOS setup](/docs/react-native/ios-setup) ·
[Keys, custody & rotation](/docs/security/key-management)
