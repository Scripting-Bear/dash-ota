---
sidebar_position: 1
title: Installation & overview
---

# Backend installation & overview

`@dash-ota/backend` stores the releases your CLI publishes and hands them to devices. It checks
each device's request signature, decides which release a device gets (runtime version, channel,
rollout), issues download tokens and records adoption. It never signs anything and never holds your
signing key.

It needs Node 20.19 or later.

```bash
npm install @dash-ota/backend
npm install express   # only if you mount it into Express
```

## Three ways to run it

| | Best for |
|---|---|
| [Express/Connect middleware](/docs/backend/express): `dashOtaMiddleware()` | adding OTA routes to an API you already run |
| [Factory](/docs/backend/umbrella): `createOtaBackend()` | wiring it into Koa, Fastify or your own server |
| [Standalone server](/docs/backend/frameworks#standalone): `node:http`, no framework | a separate OTA service, or a quick local run |

All three use the same route code, so they behave the same.

## Minimal example

```js title="server.mjs"
import express from 'express';
import { dashOtaMiddleware, rawBodySaver } from '@dash-ota/backend';

const adminToken = process.env.OTA_ADMIN_TOKEN;
if (!adminToken) throw new Error('Set OTA_ADMIN_TOKEN before starting the server.');

const app = express();
// Request signatures cover the raw body bytes; release manifests can exceed express.json's 100 kB default.
app.use(express.json({ limit: '32mb', verify: rawBodySaver }));
app.use(
  dashOtaMiddleware({
    adminToken,
    storageDir: './ota-data/storage',
    dataDir: './ota-data/db',
    verifyEnrollToken: async (token) => <YOUR_SESSION_CHECK>(token),
  }),
);
app.listen(4455);
```

`<YOUR_SESSION_CHECK>` is your own function that returns `true` for a valid user session token (the
token the app's `getEnrollToken` sends). Without `verifyEnrollToken`, any request that carries some
non-empty token can register a device. Run it with `node server.mjs`; Node 20 can't run a `.ts`
file directly.

## Where data lives

With the default disk store, releases go to `storageDir` and metadata to `dataDir`. They default to
`<working directory>/.dash-ota/storage` and `<working directory>/.dash-ota/data`. Set both
explicitly in production, back them up, and keep them out of `node_modules`: the backend refuses to
start if either is inside one, because `npm install` deletes it. For more than one server instance,
use Postgres or SQLite, Redis and S3 instead ([Storage providers](/docs/backend/providers)).

:::warning[Upgrading from 0.5.0]
0.5.0 defaulted both directories to folders inside the installed package, which `npm install`
wipes. If your 0.5.0 backend relied on those defaults, copy its `storage` and `.data` folders
(from `node_modules/@dash-ota/backend/`) somewhere safe **before** upgrading, and point
`storageDir` and `dataDir` at them.
:::

## What it can't do

- It never signs and never holds the Ed25519 private key; the [CLI](/docs/cli/overview) does.
- It can't make a release a device will accept. It can withhold releases, serve an older one you
  signed, or send a force-update prompt. See [If your update server is breached](/docs/security/breach).

Next: [Express integration](/docs/backend/express)
