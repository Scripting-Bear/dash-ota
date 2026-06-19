---
sidebar_position: 1
title: Installation & overview
---

# Backend installation & overview

`@dash-ota/backend` is a **config-driven, plug-and-play** OTA distributor. It serves pre-signed
manifests + AES-256-GCM ciphertext, enforces targeting/rollout/anti-replay, and authenticates
devices by their hardware public key — and it **never holds the signing key**.

```bash
npm install @dash-ota/backend
npm install express   # optional — only if you mount into an Express app
```

## Three ways to use it

| | Best for |
|---|---|
| [**Express/Connect middleware**](/docs/backend/express) — one `dashOtaMiddleware()` | Adding OTA to an existing API |
| [**Umbrella factory**](/docs/backend/umbrella) — `createOtaBackend()` | Owning the store/config, getting every adapter from one object |
| [**Standalone server**](/docs/backend/frameworks) — `node:http`, zero deps | A dedicated OTA service / quick POC |

All three share one **framework-agnostic route core**, so behaviour is identical.

## Minimal example

```ts
import express from 'express';
import { dashOtaMiddleware, rawBodySaver } from '@dash-ota/backend';

const app = express();
app.use(express.json({ verify: rawBodySaver }));
app.use(dashOtaMiddleware({ adminToken: process.env.OTA_ADMIN_TOKEN }));
app.listen(4455);
```

## What it does **not** do

- It never signs and never holds the Ed25519 private key (that's the [CLI](/docs/cli/overview)).
- It can serve a validly-signed *older* bundle at worst — which native rejects via the downgrade
  guard. It cannot forge a new one.

Next: [Express integration →](/docs/backend/express)
