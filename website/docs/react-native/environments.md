---
sidebar_position: 4
title: Environments & flavours
description: Wire dev / uat / prod so each embeds its own channel, signing key, and runtimeVersion.
---

# Environments & flavours

dash-ota derives the OTA environment **from your build flavour**. Each flavour embeds its own
channel + signing public key + runtimeVersion, so:

- a **dev** build only ever receives **dev-channel** OTAs,
- a bundle signed with the **wrong** environment's key is **rejected natively**.

This reuses your app's existing dev/uat/prod flavours — there's no separate "OTA environment"
system to learn.

## The five values per flavour

| Key (Android resValue / iOS Info.plist) | Example | Meaning |
|---|---|---|
| `ota_channel` / `OTA_CHANNEL` | `prod` | the release lane |
| `ota_server_url` / `OTA_SERVER_URL` | `https://ota.yourapi.com` | backend base URL |
| `ota_public_keys` / `OTA_PUBLIC_KEYS` | `BASE64KEY` | embedded Ed25519 public key(s), comma-separated |
| `ota_runtime_version` / `OTA_RUNTIME_VERSION` | `rt1` | native-compat key |
| `ota_native_build` / `OTA_NATIVE_BUILD` | `42` | native build number (force-update gate) |

## Per-environment keys

Generate **one keypair per environment** — private keys live in CI/KMS, never in the app:

```bash
npx dash-ota keygen --key-id key_dev_1   # → embed publicKeyRawB64 in dev
npx dash-ota keygen --key-id key_uat     # → uat
npx dash-ota keygen --key-id key_prod    # → prod
npx dash-ota register-key --key-id <id> --key-file .keys/<id>.public.json
```

This is what gives you key isolation. A prod build embeds only the prod public key, so a bundle
signed with the dev key — accidentally or otherwise — fails verification in native with
`manifest signature did not verify`. A leaked dev key cannot reach prod installs.

When you publish, pass the matching `--key-id`. The manifest records it, and the app verifies
against the key it embeds for that environment.

```bash
dash-ota publish --bundle-dir ./out --platform android --channel uat \
  --runtime-version auto --bundle-version 2 --key-id key_uat
```

## Android — product flavours from `.env`

The example loads `.env.{dev,uat,prod}` and injects per-flavour `resValue`:

```groovy title="android/app/build.gradle"
def envDev  = loadEnvFromFile(".env.dev")
def envProd = loadEnvFromFile(".env.prod")

flavorDimensions "env"
productFlavors {
    dev {
        dimension "env"; applicationIdSuffix ".dev"
        resValue "string", "ota_channel",      (envDev.OTA_CHANNEL ?: "dev")
        resValue "string", "ota_public_keys",  (envDev.OTA_PUBLIC_KEYS ?: "")
        resValue "string", "ota_runtime_version", (envDev.OTA_RUNTIME_VERSION ?: "embedded")
        // ...server_url, native_build
    }
    prod { dimension "env"; /* prod values */ }
}
```

Distinct `applicationIdSuffix` lets all three coexist on one device.

## iOS — xcconfig per configuration

`Config/App.{Dev,UAT,Prod}.xcconfig` set the `OTA_*` values; `Info.plist` uses `$(OTA_*)`
substitution. Wire them to `Debug/Release-{Dev,UAT,Prod}` configurations + schemes. See
[iOS setup](/docs/react-native/ios-setup).

## Reading the channel in JS

The active flavour's channel is available at runtime:

```tsx
const { channel } = useOtaUpdate(); // 'dev' | 'uat' | 'prod'
```

## Keeping the values in `.env` files

The example app keeps one file per environment and reads them from Gradle. Nothing in the library
requires this — it only ever reads the compiled-in resources — but it keeps the five values in one
place per environment:

```ini title=".env.prod"
OTA_CHANNEL=prod
OTA_SERVER_URL=https://ota.yourapi.com
OTA_PUBLIC_KEYS=<key_prod publicKeyRawB64>
OTA_RUNTIME_VERSION=rt1
OTA_NATIVE_BUILD=42
```

→ [Android setup](/docs/react-native/android-setup) · [iOS setup](/docs/react-native/ios-setup) ·
[Keys, custody & rotation](/docs/security/key-management)
