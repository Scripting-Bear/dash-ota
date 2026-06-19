---
sidebar_position: 9
title: Deployment
---

# Deployment

The distributor is a stateless-ish Node service in front of a store. Deploy it like any API.

## Docker

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

Where `server.js` mounts `dashOtaMiddleware()` into Express (or calls `createOtaBackend().listen()`).

## Behind your gateway

- Terminate **HTTPS** at your gateway/load balancer; dash-ota integrity holds even if TLS were
  broken, but you still want transport security and confidentiality.
- Mount it at the **root** of its own service, or alongside your API (the middleware only owns
  `/ota/v1/*`, `/admin/*`, `/health`).
- Pass `OTA_ADMIN_TOKEN` and your store credentials via secrets, never in the image.

## Storage

Point `storageDir`/`dataDir` at persistent volumes for the POC store, or implement a
[custom store](/docs/backend/store) backed by Postgres/Redis/object storage for scale.

## Health & observability

- `GET /health` returns `{ ok, releases }` for liveness/readiness probes.
- Wire `onConfirm` / `onPublish` / `logger` to your metrics + audit pipeline (see [Hooks](/docs/backend/hooks)).
- The server-side **auto-pause** is your safety net — alert on it.

## Env summary

`OTA_PORT`, `OTA_ADMIN_TOKEN`, `OTA_STORAGE_DIR`, `OTA_DATA_DIR`, `OTA_TS_SKEW_MS`,
`OTA_DL_TTL_MS`, `OTA_NONCE_TTL_MS`, `OTA_AUTOPAUSE_RATE`, `OTA_AUTOPAUSE_MIN`, `OTA_REQUIRE_SIG`,
`OTA_REQUIRE_ENROLL_AUTH`. See [Configuration](/docs/backend/configuration).

→ [Production hardening](/docs/backend/hardening)
