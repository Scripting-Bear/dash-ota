---
sidebar_position: 2
title: Express integration
---

# Express integration

`dashOtaMiddleware(options)` returns a standard `(req, res, next)` handler. It owns the OTA routes
and lets everything else fall through to your app.

```ts
import express from 'express';
import { dashOtaMiddleware, rawBodySaver } from '@dash-ota/backend';

const app = express();

// The OTA request signature is over the RAW body. If a global JSON parser runs first,
// stash the raw bytes with rawBodySaver; otherwise mount the OTA middleware BEFORE any parser.
app.use(express.json({ verify: rawBodySaver }));

app.use(
  dashOtaMiddleware({
    adminToken: process.env.OTA_ADMIN_TOKEN,
    verifyEnrollToken: (token) => auth.verify(token), // your app-session auth
    onConfirm: (e) => metrics.track('ota_confirm', e),
    logger: console,
  }),
);

app.listen(4455);
```

## Mount at the root

The routes are **absolute** (`/ota/v1/*`, `/admin/*`, `/health`). Do **not** mount under a
sub-path — the device signs over the request `path`, so it must match what the client signed.

```ts
app.use(dashOtaMiddleware(opts));        // ✅ correct
app.use('/ota', dashOtaMiddleware(opts)); // ❌ breaks signature verification
```

## The raw-body requirement

The device signs `[METHOD, path, installId, nonce, timestamp, sha256(body)]`, so the backend must
verify against the **exact** body bytes. Two supported setups:

1. Mount `dashOtaMiddleware` **before** any body parser (it drains the stream itself), **or**
2. Keep your global `express.json()` but add `verify: rawBodySaver` so the raw bytes are stashed on
   `req.rawBody`.

`rawBodySaver` is a body-parser `verify` callback exported for exactly this.

→ [Configuration](/docs/backend/configuration) · [Hooks](/docs/backend/hooks) · [Endpoints](/docs/backend/endpoints)
