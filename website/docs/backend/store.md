---
sidebar_position: 7
title: Bring-your-own store
---

# Bring-your-own store

The default `Store` persists releases (pre-signed manifest + ciphertext + rollout state +
adoption), enrolled installs (their device public key), and ephemeral nonce/token caches — to disk
(JSON + files). For production, swap it for Postgres + Redis + object storage by implementing the
same surface.

```ts
import { createOtaBackend, Store } from '@dash-ota/backend';

const ota = createOtaBackend({ store: new MyStore(config) });
```

## What the store is responsible for

- **Releases:** `addRelease`, `listReleases`, `getRelease`, `readCiphertext`, `setRollout`,
  `setPaused`, `rollback`, `pickEligible` (the targeting/rollout matching).
- **Installs:** `enroll` (store device public key, idempotent for key rotation),
  `getDevicePublicKey`.
- **Trusted keys:** `registerKey`, `getTrustedKey` (sanity-checks publishes against the public key).
- **Anti-replay:** `registerNonce`, `issueDownloadToken` / `consumeDownloadToken` (one-time),
  `issueServerNonce` / `consumeServerNonce`.
- **Adoption + auto-pause:** `recordConfirm` (and trips auto-pause past the threshold).
- **Native policy:** `setNativePolicy`, `resolveNativePolicy` (force-update gate).

## Recommended production mapping

| POC (default disk) | Production |
|---|---|
| `storage/*.bin` ciphertext | S3 / GCS / R2 object storage (proxy the stream) |
| `releases.json` / `installs.json` | Postgres tables |
| in-memory nonce/token caches | Redis with TTLs |

The route core is unchanged — only the `Store` implementation differs. Keep `pickEligible`'s
matching semantics identical (exact `runtimeVersion`, rollout bucket, `bundleVersion > current`,
channel, platform) so targeting stays correct.

→ [Deployment](/docs/backend/deployment)
