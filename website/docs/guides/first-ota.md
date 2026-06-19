---
sidebar_position: 1
title: Your first OTA (10 min)
---

# Your first OTA in 10 minutes

A focused walkthrough end-to-end. Assumes you've done [installation](/docs/react-native/installation).

### 1. Start a backend
```ts
import express from 'express';
import { dashOtaMiddleware, rawBodySaver } from '@dash-ota/backend';
const app = express();
app.use(express.json({ verify: rawBodySaver }));
app.use(dashOtaMiddleware({ adminToken: 'dev-admin-token' }));
app.listen(4455);
```
For local dev, set `OTA_REQUIRE_ENROLL_AUTH=false` so the example app can enroll without a session token.

### 2. Keys
```bash
npx dash-ota keygen --key-id key_dev_1
npx dash-ota register-key --key-id key_dev_1 --key-file .keys/key_dev_1.public.json
```
Embed `publicKeyRawB64` as `ota_public_keys` (Android) / `OTA_PUBLIC_KEYS` (iOS), with
`ota_server_url = http://10.0.2.2:4455` (Android emulator) and a `runtimeVersion`.

### 3. Wrap the app + build a **release**
```tsx
<DashOtaProvider config={{ appVersion: '1.0.0', storage, getEnrollToken: async () => 'dev' }}>
  <App />
</DashOtaProvider>
```
Make a release build (debug uses Metro), install, and launch — watch for `[dash-ota] enrolled device key`.

### 4. Publish a visible change
Change something obvious in your JS, then:
```bash
dash-ota bundle --project . --platform android --out ./out
# compile ./out to HBC with your hermesc
dash-ota publish --bundle-dir ./out --platform android --channel dev \
  --runtime-version auto --bundle-version 2 --release-note "first OTA"
```

### 5. See it apply
Relaunch the app **twice** (apply is on cold start). Your change is live. 🎉

### Troubleshooting
If nothing applies, check [Troubleshooting](/docs/react-native/troubleshooting) — the usual causes
are a debug build, a `runtimeVersion` mismatch, or `markHealthy()` never being called.
