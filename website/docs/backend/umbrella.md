---
sidebar_position: 4
title: Umbrella factory
---

# Umbrella factory — `createOtaBackend()`

When you want to own the store + config once and reach every adapter from a single object:

```ts
import { createOtaBackend } from '@dash-ota/backend';

const ota = createOtaBackend({
  adminToken: process.env.OTA_ADMIN_TOKEN,
  logger: console,
});

app.use(ota.middleware);     // Express/Connect middleware
await ota.listen(4455);      // OR run standalone on node:http
```

## What it returns

| Property | Type | Description |
|---|---|---|
| `config` | `BackendConfig` | the fully-resolved configuration |
| `store` | `Store` | the persistence + lookup layer (disk-backed by default) |
| `routes` | `OtaRoute[]` | the framework-agnostic route table |
| `middleware` | `(req,res,next) => void` | a Connect/Express middleware over those routes |
| `listen(port?)` | `Promise<Server>` | start a standalone `node:http` server |

The store + routes are built **once**, so `.middleware` and `.listen()` share state — no
rebuilding per call.

## Bring your own store

Pass a custom `store` to back persistence with Postgres/Redis/object storage instead of disk:

```ts
import { createOtaBackend, Store } from '@dash-ota/backend';
const ota = createOtaBackend({ store: new MyPostgresStore(config) });
```

→ [Bring-your-own store](/docs/backend/store)
