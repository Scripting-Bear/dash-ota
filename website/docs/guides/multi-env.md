---
sidebar_position: 2
title: Multi-environment setup
---

# Multi-environment setup (dev / uat / prod)

Goal: three flavours, each with its **own channel + signing key + runtimeVersion**, so OTAs are
isolated per environment and a wrong-key bundle is rejected.

### 1. Three keypairs
```bash
npx dash-ota keygen --key-id key_dev_1
npx dash-ota keygen --key-id key_uat
npx dash-ota keygen --key-id key_prod
# register all three with the backend
```

### 2. `.env` per environment
```ini title=".env.prod"
OTA_CHANNEL=prod
OTA_SERVER_URL=https://ota.yourapi.com
OTA_PUBLIC_KEYS=<key_prod publicKeyRawB64>
OTA_RUNTIME_VERSION=rt1
OTA_NATIVE_BUILD=42
```

### 3. Android product flavours
Inject the `.env` values as `resValue` per flavour (see [Android setup](/docs/react-native/android-setup)
and [Environments](/docs/react-native/environments)). Distinct `applicationIdSuffix` lets all three
coexist on one device.

### 4. iOS configurations
`Config/App.{Dev,UAT,Prod}.xcconfig` → `Info.plist` `$(OTA_*)`; wire to `Debug/Release-{Dev,UAT,Prod}`
configs + schemes (see [iOS setup](/docs/react-native/ios-setup)).

### 5. Publish to a channel
```bash
dash-ota publish --bundle-dir ./out --platform android --channel uat \
  --runtime-version auto --bundle-version 2 --key-id key_uat
```

## What you get
- The **dev** app only receives **dev-channel** OTAs; uat/prod likewise.
- A bundle signed with the wrong environment's key is **rejected natively** ("manifest signature
  did not verify") — proven key isolation.
- `useOtaUpdate().channel` tells you which environment a running app is in.
