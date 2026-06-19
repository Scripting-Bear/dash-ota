---
sidebar_position: 2
title: Quickstart
description: Stand up the backend, sign a key, wire the client, and ship your first OTA.
---

# Quickstart

This walks the whole loop locally: run the backend, generate a signing key, wire the client, and
publish a signed update. Budget ~15 minutes.

:::tip
Prefer to learn by reading? Jump to [Core Concepts](/docs/concepts/lifecycle). Prefer a real app?
Clone the repo and run `packages/rn/example` — it's a full dev/uat/prod demo.
:::

## 1. Run the backend

Mount it into an Express app:

```ts title="server.ts"
import express from 'express';
import { dashOtaMiddleware, rawBodySaver } from '@dash-ota/backend';

const app = express();
app.use(express.json({ verify: rawBodySaver })); // keep raw bytes for the request signature
app.use(
  dashOtaMiddleware({
    adminToken: process.env.OTA_ADMIN_TOKEN ?? 'dev-admin-token',
    verifyEnrollToken: (t) => !!t, // replace with your real session check
  }),
);
app.listen(4455);
```

```bash
npm i @dash-ota/backend express
node server.ts   # serving on http://localhost:4455
```

→ Full details in the [backend guide](/docs/backend/installation).

## 2. Generate a signing key

```bash
npx dash-ota keygen --key-id key_dev_1
# writes .keys/key_dev_1.{private.pem,public.pem,public.json}
# prints publicKeyRawB64 — you embed this in the app, and register it with the backend
npx dash-ota register-key --key-id key_dev_1 --key-file .keys/key_dev_1.public.json
```

→ Full command reference in the [CLI overview](/docs/cli/overview).

## 3. Wire the client

```bash
npm i react-native-dash-ota
cd ios && pod install
```

Embed the per-flavour config natively (channel, server URL, **public key**, runtimeVersion) — see
[Android setup](/docs/react-native/android-setup) and [iOS setup](/docs/react-native/ios-setup) —
then wrap your app:

```tsx title="App.tsx"
import { DashOtaProvider } from 'react-native-dash-ota';

export default function Root() {
  return (
    <DashOtaProvider config={{ appVersion: '1.0.0', storage, getEnrollToken }}>
      <App />
    </DashOtaProvider>
  );
}
```

On launch the provider enrolls the device key and silently checks for an update.

## 4. Publish an OTA

```bash
# bundle your JS (compile to Hermes HBC for Hermes builds), then:
npx dash-ota publish \
  --bundle-dir ./out --platform android --channel dev \
  --runtime-version auto --bundle-version 2 \
  --release-note "My first OTA"
```

Relaunch the app twice (apply happens on cold start) — the new bundle is now running. 🎉

## 5. Operate it

```bash
npx dash-ota list                              # releases + adoption/health
npx dash-ota rollout  --bundle-id <id> --pct 25  # ramp a staged rollout
npx dash-ota rollback --bundle-id <id>           # pull a bad release
```

## What just happened

The CLI **signed** the manifest with your private key and **encrypted** the bundle. The backend
stored the pre-signed data and served it after verifying your device-key-signed request. The
client downloaded it and — **in native** — verified the Ed25519 signature against the embedded
public key, decrypted, hash-checked every file, and staged it atomically.

→ Next: [The lifecycle in detail](/docs/concepts/lifecycle) · [Set up dev/uat/prod](/docs/guides/multi-env)
