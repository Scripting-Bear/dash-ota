# @dash-ota/backend

The server half of [dash-ota](https://scripting-bear.github.io/dash-ota/), self-hosted over-the-air
updates for React Native. It stores the releases `@dash-ota/cli` publishes and hands them to
devices: it checks each device's request signature (ECDSA P-256 device keys), picks the release a
device should get (runtime version, channel, rollout), issues download tokens and records adoption.
It never signs anything and never holds your signing key, so a breach of this server can't produce
an update your apps will accept.

Docs: https://scripting-bear.github.io/dash-ota/docs/backend/installation

## Install

Node 20.19 or later.

```sh
npm install @dash-ota/backend
npm install express   # only if you mount it into Express
```

## Use

```js
// server.mjs
import express from 'express';
import { dashOtaMiddleware, rawBodySaver } from '@dash-ota/backend';

const app = express();

// Request signatures cover the raw body; release manifests can exceed express.json's 100 kB default.
app.use(express.json({ limit: '32mb', verify: rawBodySaver }));

app.use(
  dashOtaMiddleware({
    adminToken: process.env.OTA_ADMIN_TOKEN,         // protects /admin/*; no default
    storageDir: '/var/lib/dash-ota/storage',         // release files
    dataDir: '/var/lib/dash-ota/data',               // release and device metadata
    verifyEnrollToken: async (token) => checkSession(token), // your own session check
    logger: console,
  }),
);

app.listen(4455);
```

`checkSession` stands for your own function that returns `true` for a valid user session token.
Mount the middleware at the root: the routes are absolute (`/ota/v2/*`, `/admin/*`, `/health`,
`/ready`) and anything else falls through to `next()`. The same routes are available as
`createOtaBackend(options)` (with `.middleware` and `.listen()`), as a standalone server
(`node node_modules/@dash-ota/backend/dist/server.js`, configured by environment variables), and
through Postgres, SQLite, Redis and S3 adapters.

## Upgrading from 0.5.0

0.5.0 kept its data inside `node_modules/@dash-ota/backend/` by default, which `npm install` deletes.
From 0.5.1 the defaults are `<working directory>/.dash-ota/storage` and `.dash-ota/data`, and the
server refuses to start with a data directory inside `node_modules`. If you relied on the old
defaults, copy `node_modules/@dash-ota/backend/storage` and `.data` somewhere safe before upgrading,
and point `storageDir` and `dataDir` at them.

## Configuration

Every option has an environment variable and a default that fails closed:
https://scripting-bear.github.io/dash-ota/docs/backend/configuration

## License

MIT
