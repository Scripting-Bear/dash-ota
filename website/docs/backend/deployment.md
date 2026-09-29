---
sidebar_position: 9
title: Deployment
---

# Deployment

The backend is an ordinary Node service (Node 20.19 or later) in front of a store. Deploy it like any
other API.

## The smallest thing that works

A folder with a `package.json`, the `server.mjs` from [Installation](/docs/backend/installation)
(or the one below) and a Dockerfile:

```json title="package.json"
{
  "name": "ota-server",
  "private": true,
  "type": "module",
  "dependencies": {
    "@dash-ota/backend": "^0.5.1"
  }
}
```

```js title="server.mjs"
import { createOtaBackend } from '@dash-ota/backend';

const adminToken = process.env.OTA_ADMIN_TOKEN;
if (!adminToken) throw new Error('Set OTA_ADMIN_TOKEN.');

await createOtaBackend({
  adminToken,
  storageDir: process.env.OTA_STORAGE_DIR ?? '/data/storage',
  dataDir: process.env.OTA_DATA_DIR ?? '/data/db',
  verifyEnrollToken: async (token) => <YOUR_SESSION_CHECK>(token),
  logger: console,
}).listen(Number(process.env.OTA_PORT ?? 4455));
```

```dockerfile title="Dockerfile"
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY server.mjs ./
EXPOSE 4455
CMD ["node", "server.mjs"]
```

Run `npm install` once locally to create a `package-lock.json`, and switch the Dockerfile to
`npm ci --omit=dev` from then on. `<YOUR_SESSION_CHECK>` is your function that validates the
enroll token your app sends.

```bash
docker build -t ota-server .
docker run -d --name ota -p 4455:4455 \
  -e OTA_ADMIN_TOKEN=<YOUR_ADMIN_TOKEN> \
  -v ota-data:/data \
  ota-server
```

The `ota-data` volume holds every release; back it up. This runs on one host with the built-in
disk store, and it's enough until you need more than one instance.

## A production stack

For more than one instance, move the metadata to Postgres, the cache to Redis and the files to an
S3-compatible bucket. Add the drivers to the image:

```json title="package.json (dependencies)"
{
  "@dash-ota/backend": "^0.5.1",
  "pg": "^8",
  "ioredis": "^5",
  "@aws-sdk/client-s3": "^3"
}
```

With `databaseUrl`, `redisUrl` and `s3Bucket` set through the environment, `server.mjs` needs no
storage settings; the disk directories are then unused. A compose file for one app instance with
everything it needs:

```yaml title="docker-compose.yml"
services:
  ota:
    build: .
    ports: ["4455:4455"]
    environment:
      OTA_ADMIN_TOKEN: "${OTA_ADMIN_TOKEN}"      # required, no default
      OTA_DATABASE_URL: "postgres://ota:ota@db:5432/ota"
      OTA_REDIS_URL: "redis://cache:6379"
      OTA_S3_BUCKET: "ota-bundles"
      OTA_S3_ENDPOINT: "http://blob:9000"
      OTA_S3_FORCE_PATH_STYLE: "true"
      OTA_S3_REGION: "us-east-1"
      AWS_ACCESS_KEY_ID: "minioadmin"
      AWS_SECRET_ACCESS_KEY: "minioadmin"
    depends_on: [db, cache, blob]

  db:
    image: postgres:16-alpine
    environment: { POSTGRES_USER: ota, POSTGRES_PASSWORD: ota, POSTGRES_DB: ota }
    volumes: ["dbdata:/var/lib/postgresql/data"]

  cache:
    image: redis:7-alpine
    command: ["redis-server", "--appendonly", "yes"]
    volumes: ["cachedata:/data"]

  blob:
    image: minio/minio
    command: server /data --console-address ":9001"
    ports: ["9001:9001"]
    environment: { MINIO_ROOT_USER: minioadmin, MINIO_ROOT_PASSWORD: minioadmin }
    volumes: ["blobdata:/data"]

volumes: { dbdata: {}, cachedata: {}, blobdata: {} }
```

Create the `ota-bundles` bucket once, in the MinIO console on port 9001 or with `mc mb`. Replace the
example passwords before this leaves your machine, and put the TLS proxy below in front of it.

## Reverse proxy and TLS

Terminate TLS at the proxy and forward to the service. The OTA routes are absolute (`/ota/v2/*`,
`/admin/*`, `/health`, `/ready`), so serve them at the root. Under a sub-path, request signatures
stop verifying, because they cover the path the client sent.

```nginx
server {
  listen 443 ssl;
  server_name ota.example.com;
  # ssl_certificate / ssl_certificate_key ...
  location / {
    proxy_pass http://ota:4455;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    client_max_body_size 100m;   # at least OTA_MAX_BLOB_BYTES (64 MiB by default), for file uploads
    proxy_buffering off;         # blob downloads stream and serve Range; buffering breaks resume
  }
}
```

Serve `/admin/*` over HTTPS only: the admin token is the CLI's publishing credential. Put flood
protection for `/enroll` and `/check` here too. The service rate-limits each install, but limiting
traffic across installs is the proxy's job.

## Liveness and readiness are different probes

- `GET /health` is liveness. It returns `{ "ok": true }` and never touches storage. Use it for the
  container liveness probe, so a database blip doesn't restart a healthy process.
- `GET /ready` is readiness. It queries the store and returns `200 { "ready": true, "releases": N }`,
  or `503 { "ready": false }` when the store doesn't answer. Use it for load-balancer rotation, so an
  instance that can't reach its database stops getting traffic.

```yaml
livenessProbe:  { httpGet: { path: /health, port: 4455 } }
readinessProbe: { httpGet: { path: /ready,  port: 4455 } }
```

## Scaling and backups

More than one instance needs a shared Redis. Otherwise the replay protection, download tokens and
rate-limit counters live in each process, and a request replayed against another instance gets
through. Postgres and S3 are shared already.

Back up Postgres and the bucket (or the data volume, with the disk store). The cache holds nothing
you need to keep: losing it only means devices get fresh tokens.

## Secrets and configuration

Pass `OTA_ADMIN_TOKEN` and your store credentials as secrets, never baked into the image. The full
list of variables and their defaults is in [Configuration](/docs/backend/configuration).

Connect `onConfirm`, `onPublish` and `logger` to your metrics and audit logs ([Hooks](/docs/backend/hooks)),
and alert when `onConfirm` reports `autoPaused: true`: that is a release being pulled because
devices are failing.

→ [Production hardening](/docs/backend/hardening) · [Storage](/docs/backend/providers)
