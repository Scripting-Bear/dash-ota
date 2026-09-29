---
sidebar_position: 3
title: Other frameworks & standalone
---

# Other frameworks & standalone

The middleware is a plain Connect-style `(req, res, next)` function that doesn't depend on Express,
so it runs in Connect directly and in Fastify or Koa through their usual adapters. There is also a
standalone server with no framework at all.

In each example below, `adminToken` comes from `process.env.OTA_ADMIN_TOKEN`; add
`verifyEnrollToken` and explicit data directories as in [Express integration](/docs/backend/express).

## Connect

```js
import connect from 'connect';
import { dashOtaMiddleware } from '@dash-ota/backend';

const app = connect();
app.use(dashOtaMiddleware({ adminToken: process.env.OTA_ADMIN_TOKEN }));
app.listen(4455);
```

## Fastify

Mount Connect-style middleware with `@fastify/middie`:

```js
import Fastify from 'fastify';
import middie from '@fastify/middie';
import { dashOtaMiddleware } from '@dash-ota/backend';

const app = Fastify();
await app.register(middie);
app.use(dashOtaMiddleware({ adminToken: process.env.OTA_ADMIN_TOKEN }));
await app.listen({ port: 4455 });
```

## Koa

Bridge it with `koa-connect`:

```js
import Koa from 'koa';
import c2k from 'koa-connect';
import { dashOtaMiddleware } from '@dash-ota/backend';

const app = new Koa();
app.use(c2k(dashOtaMiddleware({ adminToken: process.env.OTA_ADMIN_TOKEN })));
app.listen(4455);
```

## Standalone

The factory starts a plain `node:http` server:

```js title="server.mjs"
import { createOtaBackend } from '@dash-ota/backend';

await createOtaBackend({ adminToken: process.env.OTA_ADMIN_TOKEN }).listen(4455);
```

Or skip writing a file and run the server that ships in the package, configured entirely by
environment variables ([Configuration](/docs/backend/configuration)):

```bash
OTA_ADMIN_TOKEN=<YOUR_ADMIN_TOKEN> \
OTA_STORAGE_DIR=/var/lib/dash-ota/storage OTA_DATA_DIR=/var/lib/dash-ota/data \
node node_modules/@dash-ota/backend/dist/server.js
```

It prints where it keeps its data and the address it listens on:

```
[dash-ota-backend] metadata directory: /var/lib/dash-ota/data
[dash-ota-backend] blob directory: /var/lib/dash-ota/storage
[dash-ota-backend] listening on http://localhost:4455 (require-sig=true)
```

→ [Factory](/docs/backend/umbrella) · [Deployment](/docs/backend/deployment)
