# @dash-ota/backend

The [dash-ota](https://github.com/Scripting-Bear/dash-ota) OTA distributor — a **config-driven,
plug-and-play** backend for React Native over-the-air updates. Serves **pre-signed** manifests +
AES-256-GCM ciphertext, enforces targeting / rollout / anti-replay, and authenticates devices by
their **hardware public key (ECDSA P-256)**. It **never signs and never holds the signing key**.

Mount it into any **Express / Connect** app with one middleware, or run it standalone — both
share the same framework-agnostic route core.

> 📖 **Full integration guide:** https://github.com/Scripting-Bear/dash-ota/blob/main/docs/backend.md

## Installation

```sh
npm install @dash-ota/backend
npm install express   # optional — only if mounting into an Express app
```

## Usage

```ts
import express from 'express';
import { dashOtaMiddleware, rawBodySaver } from '@dash-ota/backend';

const app = express();

// The OTA request signature is over the RAW body. Keep the raw bytes (or mount before any parser).
app.use(express.json({ verify: rawBodySaver }));

app.use(
  dashOtaMiddleware({
    adminToken: process.env.OTA_ADMIN_TOKEN,            // protects /admin/* (used by @dash-ota/cli)
    verifyEnrollToken: (token) => auth.verify(token),   // your app-session auth
    onConfirm: (e) => metrics.track('ota_confirm', e),  // your analytics
    logger: console,
  }),
);

app.listen(4455);
```

Mount at the **root** — routes are absolute (`/ota/v1/*`, `/admin/*`, `/health`) and anything the
middleware doesn't own falls through to `next()`. Also available: `createOtaBackend(options)`
(umbrella with `.middleware` / `.listen()`), a standalone `node:http` server, and a bring-your-own
`store`.

## Config & hooks

All optional with safe defaults (and env fallbacks): `adminToken`, `storageDir`, `dataDir`,
`timestampSkewMs`, `downloadTokenTtlMs`, `nonceTtlMs`, `autoPauseFailureRate`,
`autoPauseMinSamples`, `requireRequestSignature`, `requireEnrollAuth`, plus hooks
`verifyEnrollToken` / `onConfirm` / `onPublish` / `logger` / `store`. Full table + endpoint
reference in the [guide](https://github.com/Scripting-Bear/dash-ota/blob/main/docs/backend.md).

## License

MIT
