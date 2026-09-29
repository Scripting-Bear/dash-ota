---
sidebar_position: 4
title: Factory
---

# The factory: `createOtaBackend()`

Build the store and configuration once, and get every way of serving it from one object:

```js
import { createOtaBackend } from '@dash-ota/backend';

const ota = createOtaBackend({
  adminToken: process.env.OTA_ADMIN_TOKEN,
  storageDir: '/var/lib/dash-ota/storage',
  dataDir: '/var/lib/dash-ota/data',
  logger: console,
});

app.use(ota.middleware);   // mount into your Express/Connect app...
// await ota.listen(4455); // ...or run it on its own
```

`app` is your existing Express or Connect app.

## What it returns

| Property | Type | Description |
|---|---|---|
| `config` | `BackendConfig` | the resolved configuration |
| `store` | `Store` | storage and lookups (disk by default) |
| `routes` | `OtaRoute[]` | the route table, independent of any framework |
| `middleware` | `(req, res, next) => void` | Connect/Express middleware over those routes |
| `listen(port?)` | `Promise<Server>` | start a `node:http` server (default port: `config.port`) |

The store and routes are built once, so `middleware` and `listen()` share the same state.

## Your own storage

Pass `providers` to swap the database, file storage or cache for Postgres, SQLite, S3 or Redis:

```js
import { createOtaBackend, PostgresDatabaseProvider } from '@dash-ota/backend';

const ota = createOtaBackend({
  adminToken: process.env.OTA_ADMIN_TOKEN,
  providers: { db: new PostgresDatabaseProvider({ url: process.env.OTA_DATABASE_URL }) },
});
```

→ [Storage providers](/docs/backend/providers)
