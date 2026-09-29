---
sidebar_position: 2
title: Express integration
---

# Express integration

`dashOtaMiddleware(options)` returns a standard `(req, res, next)` handler. It answers the OTA
routes and passes everything else on to the rest of your app.

```js title="server.mjs"
import express from 'express';
import { dashOtaMiddleware, rawBodySaver } from '@dash-ota/backend';

const app = express();

// Request signatures cover the raw body. With a global JSON parser, keep the raw bytes with
// rawBodySaver, and raise the limit: release manifests can exceed express.json's 100 kB default.
app.use(express.json({ limit: '32mb', verify: rawBodySaver }));

app.use(
  dashOtaMiddleware({
    adminToken: process.env.OTA_ADMIN_TOKEN,
    storageDir: './ota-data/storage',
    dataDir: './ota-data/db',
    verifyEnrollToken: async (token) => <YOUR_SESSION_CHECK>(token),
    onConfirm: (event) => console.log('ota confirm', event.bundleId, event.status),
    logger: console,
  }),
);

app.listen(4455);
```

`<YOUR_SESSION_CHECK>` is your own function that returns `true` for a valid session token. The
middleware applies its own size limits on top of the parser's: 64 KiB for device requests, and
`maxAdminBodyBytes` (32 MiB by default) for authenticated admin requests.

## Mount it at the root

The routes are absolute (`/ota/v2/*`, `/admin/*`, `/health`, `/ready`). The device signs the
request path it sends, so the path the server sees has to be the same.

```js
app.use(dashOtaMiddleware(options));        // correct
app.use('/ota', dashOtaMiddleware(options)); // breaks signature verification
```

## The raw body

The device signs the method, path, install id, nonce, timestamp and the SHA-256 of the body, so the
server has to check the exact bytes it received. Either:

1. mount `dashOtaMiddleware` before any body parser (it reads the stream itself), or
2. keep your global `express.json()` and add `verify: rawBodySaver`, which keeps the raw bytes on
   `req.rawBody`.

A request with an empty or malformed JSON body gets `400 bad_request` either way.

→ [Configuration](/docs/backend/configuration) · [Hooks](/docs/backend/hooks) · [Endpoints](/docs/backend/endpoints)
