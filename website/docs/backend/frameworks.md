---
sidebar_position: 3
title: Other frameworks & standalone
---

# Other frameworks & standalone

The middleware is a plain Connect-style `(req, res, next)` function with **zero dependency on
Express**, so it works with Connect, and (via an adapter) Fastify/Koa. There's also a
zero-dependency standalone server.

## Connect

```ts
import connect from 'connect';
import { dashOtaMiddleware } from '@dash-ota/backend';
const app = connect();
app.use(dashOtaMiddleware({ adminToken }));
```

## Fastify

Use `@fastify/middie` (or `@fastify/express`) to mount Connect-style middleware:

```ts
import Fastify from 'fastify';
import middie from '@fastify/middie';
import { dashOtaMiddleware } from '@dash-ota/backend';

const app = Fastify();
await app.register(middie);
app.use(dashOtaMiddleware({ adminToken }));
```

## Koa

Bridge with `koa-connect`:

```ts
import Koa from 'koa';
import c2k from 'koa-connect';
import { dashOtaMiddleware } from '@dash-ota/backend';

const app = new Koa();
app.use(c2k(dashOtaMiddleware({ adminToken })));
```

## Standalone (zero deps)

The umbrella factory boots a `node:http` server with no Express:

```ts
import { createOtaBackend } from '@dash-ota/backend';
await createOtaBackend({ adminToken: process.env.OTA_ADMIN_TOKEN }).listen(4455);
```

Or via env only (the package's own `server` entry reads `OTA_*` env vars):

```bash
OTA_ADMIN_TOKEN=… OTA_PORT=4455 node -e "require('@dash-ota/backend').createOtaBackend().listen()"
```

→ [Umbrella factory](/docs/backend/umbrella)
