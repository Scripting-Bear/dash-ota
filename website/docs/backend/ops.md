---
sidebar_position: 9
title: Deploying (docker-compose, TLS, probes)
---

# Deploying: docker-compose, TLS & health probes

A production single-stack: the OTA service behind a TLS-terminating reverse proxy, with Postgres,
Redis, and MinIO (S3-compatible) for durable multi-instance storage.

## docker-compose

```yaml
services:
  ota:
    image: node:20-alpine
    working_dir: /app
    command: sh -c "npm ci && npm run backend"
    environment:
      OTA_PORT: "4455"
      OTA_ADMIN_TOKEN: "${OTA_ADMIN_TOKEN}"      # required — no default (fail-closed)
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

Install the optional peers the adapters need in your service image: `npm i pg ioredis @aws-sdk/client-s3`.
Create the `ota-bundles` bucket once (MinIO console at `:9001`, or `mc mb`).

## Reverse proxy + TLS

Terminate TLS at the proxy and forward to the service. The OTA routes are absolute (`/ota/v1/*`,
`/admin/*`, `/health`, `/ready`), so mount at the **root** — a sub-path breaks request-signature
verification.

```nginx
server {
  listen 443 ssl;
  server_name ota.example.com;
  # ssl_certificate / ssl_certificate_key ...
  location / {
    proxy_pass http://ota:4455;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    client_max_body_size 120m;   # >= OTA_MAX_BUNDLE_BYTES for /admin/publish
  }
}
```

Serve `/admin/*` only over HTTPS — the admin token is the CLI's publish credential. IP/flood
protection for `/enroll` + `/check` belongs here at the proxy (the app has per-install rate limits;
cross-install limiting is the proxy's job).

## Health vs readiness

Two distinct probes:

- **`GET /health`** — liveness. Returns `{ "ok": true }` and **never touches storage**. Use it for
  the container/orchestrator liveness probe: it must not fail (and trigger a restart) just because
  the database is briefly unreachable.
- **`GET /ready`** — readiness. Queries the store; returns `200 { "ready": true, "releases": N }`
  when the backing store is reachable, else `503 { "ready": false }`. Use it for load-balancer
  rotation, so an instance with an unreachable DB/cache is pulled out.

```yaml
# Kubernetes
livenessProbe:  { httpGet: { path: /health, port: 4455 } }
readinessProbe: { httpGet: { path: /ready,  port: 4455 } }
```

## Scaling & backups

- **Multiple replicas** require a **shared cache (Redis)** — the anti-replay guard, one-time tokens,
  and rate-limit counters are otherwise per-process. Postgres + S3 are inherently shared.
- **Back up** Postgres (`pg_dump`) and the blob store (bucket replication / lifecycle). The cache is
  ephemeral by design — losing it only forces fresh nonces/tokens, never data loss.
```
