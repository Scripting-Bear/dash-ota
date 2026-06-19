---
sidebar_position: 5
title: Configuration
---

# Configuration

Every option is optional with a safe default, and each has an **env fallback** (handy for the
standalone server). Pass only what you need.

```ts
dashOtaMiddleware({
  adminToken: process.env.OTA_ADMIN_TOKEN,
  requireRequestSignature: true,
  requireEnrollAuth: true,
  // ...hooks (see Hooks page)
});
```

## Options & env

| Option | Env | Default | Meaning |
|---|---|---|---|
| `port` | `OTA_PORT` | `4455` | standalone listen port |
| `adminToken` | `OTA_ADMIN_TOKEN` | `dev-admin-token` | bearer for `/admin/*` (header `x-ota-admin-token`) |
| `storageDir` | `OTA_STORAGE_DIR` | `<pkg>/storage` | where encrypted bundles are stored |
| `dataDir` | `OTA_DATA_DIR` | `<pkg>/.data` | release/install metadata (JSON) |
| `timestampSkewMs` | `OTA_TS_SKEW_MS` | `300000` | allowed client clock skew |
| `downloadTokenTtlMs` | `OTA_DL_TTL_MS` | `120000` | one-time download token TTL |
| `nonceTtlMs` | `OTA_NONCE_TTL_MS` | `600000` | replay-nonce cache TTL |
| `autoPauseFailureRate` | `OTA_AUTOPAUSE_RATE` | `0.2` | failure rate that auto-pauses a rollout |
| `autoPauseMinSamples` | `OTA_AUTOPAUSE_MIN` | `5` | min confirms before auto-pause can trip |
| `requireRequestSignature` | `OTA_REQUIRE_SIG` | `true` | enforce the device-key signature on `/check` + `/confirm` |
| `requireEnrollAuth` | `OTA_REQUIRE_ENROLL_AUTH` | `true` | require an enroll session token (see [`verifyEnrollToken`](/docs/backend/hooks)) |

## Production posture

Keep `requireRequestSignature` and `requireEnrollAuth` **on**, set a strong `adminToken`, and run
behind HTTPS. The env knobs let you tune anti-replay windows and auto-pause sensitivity without
code changes.

## `resolveBackendConfig`

`resolveBackendConfig(partial)` layers your options over the env/default config — it's what the
middleware/factory call internally. Useful if you want the resolved config object directly.

→ [Hooks](/docs/backend/hooks) · [Endpoints](/docs/backend/endpoints)
