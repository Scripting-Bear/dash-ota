---
sidebar_position: 9
title: Deployment
---

# Deployment

The distributor is an ordinary Node service in front of a store. Deploy it like any other API.

## The smallest thing that works

```dockerfile title="Dockerfile"
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV OTA_PORT=4455
EXPOSE 4455
CMD ["node", "server.js"]
```

`server.js` either mounts `dashOtaMiddleware()` into your Express app or calls
`createOtaBackend().listen()`. Point `OTA_STORAGE_DIR` and `OTA_DATA_DIR` at persistent volumes and
this runs on one box with the built-in disk store. It is a real deployment, and it is enough until
you need more than one instance.

## A production stack

Once you want durability and more than one replica, the disk store stops being the right answer.
This is the OTA service behind a TLS-terminating proxy, with Postgres for metadata, Redis for the
shared cache, and MinIO (or any S3-compatible bucket) for blobs:

```yaml title="docker-compose.yml"
services:
  ota:
    image: node:20-alpine
    working_dir: /app
    command: sh -c "npm ci && npm run backend"
    environment:
      OTA_PORT: "4455"
      OTA_ADMIN_TOKEN: "${OTA_ADMIN_TOKEN}"      # required — no default, fails closed
      OTA_DATABASE_URL: "postgres://ota:ota@db:5432/ota"
      OTA_REDIS_URL: "redis://cache:6379"
      OTA_S3_BUCKET: "ota-bundles"
      OTA_S3_ENDPOINT: "http://blob:9000"
      OTA_S3_FORCE_PATH_STYLE: "true"
      OTA_S3_REGION: "us-east-1"
      AWS_ACCESS_KEY_ID: "minioadmin"
      AWS_SECRET_ACCESS_KEY: "minioadmin"
      OTA_MAX_BUNDLE_BYTES: "104857600"          # 100 MiB
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
    environment: { MINIO_ROOT_USER: minioadmin, MINIO_ROOT_PASSWORD: minioadmin }
    volumes: ["blobdata:/data"]

volumes: { dbdata: {}, cachedata: {}, blobdata: {} }
```

The adapters are optional peer dependencies, so install the ones you use in your service image:
`npm i pg ioredis @aws-sdk/client-s3`. Create the bucket once, from the MinIO console on `:9001`
or with `mc mb`.

## Reverse proxy and TLS

Terminate TLS at the proxy and forward to the service. The OTA routes are absolute — `/ota/v2/*`,
`/admin/*`, `/health`, `/ready` — so mount at the **root**. A sub-path mount breaks request
signature verification, because the signature covers the path the client sent.

```nginx
server {
  listen 443 ssl;
  server_name ota.example.com;
  # ssl_certificate / ssl_certificate_key ...
  location / {
    proxy_pass http://ota:4455;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    client_max_body_size 120m;   # >= OTA_MAX_BLOB_BYTES, for the blob upload route
    proxy_buffering off;         # blob downloads stream and serve Range; buffering breaks resume
  }
}
```

Serve `/admin/*` over HTTPS only — the admin token is the CLI's publish credential. Flood
protection for `/enroll` and `/check` belongs here too: the service rate-limits per install, but
limiting across installs is the proxy's job.

## Liveness and readiness are different probes

This distinction matters more than it looks:

- **`GET /health`** — liveness. Returns `{ "ok": true }` and **never touches storage**. Use it for
  the container liveness probe, so a briefly unreachable database does not restart a healthy
  process.
- **`GET /ready`** — readiness. Queries the store. Returns `200 { "ready": true, "releases": N }`
  when the backing store answers, `503 { "ready": false }` when it does not. Use it for load
  balancer rotation, so an instance that cannot reach its database is pulled out of service.

```yaml
livenessProbe:  { httpGet: { path: /health, port: 4455 } }
readinessProbe: { httpGet: { path: /ready,  port: 4455 } }
```

## Scaling and backups

More than one replica needs a **shared Redis**. The anti-replay nonce guard, the download tokens
and the rate-limit counters are per-process otherwise, which means a device can replay a request
against a different instance. Postgres and S3 are shared by nature.

Back up Postgres and the blob store. The cache is ephemeral on purpose — losing it forces fresh
nonces and tokens, and costs no data.

## Secrets and configuration

Pass `OTA_ADMIN_TOKEN` and your store credentials as secrets, never baked into the image. The full
list of variables and their defaults is in [Configuration](/docs/backend/configuration); the ones
that matter most in production are `OTA_ADMIN_TOKEN`, `OTA_DATABASE_URL`, `OTA_REDIS_URL`,
`OTA_S3_BUCKET`, `OTA_MAX_BUNDLE_BYTES`, `OTA_AUTOPAUSE_RATE` and `OTA_AUTOPAUSE_MIN`.

Wire `onConfirm`, `onPublish` and `logger` into your metrics and audit pipeline — see
[Hooks](/docs/backend/hooks). Server-side auto-pause is the safety net that pulls a failing
release without you; alert on it.

→ [Production hardening](/docs/backend/hardening) · [Storage](/docs/backend/providers)
