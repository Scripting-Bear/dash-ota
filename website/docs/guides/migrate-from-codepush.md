---
sidebar_position: 7
title: Migrate from CodePush / hot-updater
---

# Migrate from CodePush / hot-updater

CodePush (App Center) is retiring, and hot-updater is a popular self-hosted successor. dash-ota
covers the same workflow and adds a stronger security model.

## Concept mapping

| CodePush / hot-updater | dash-ota |
|---|---|
| `codePush(App)` / hot-updater wrapper | `<DashOtaProvider config={…}>` |
| deployment keys / `channel` | `channel` per build flavour |
| `targetBinaryVersion` / `targetAppVersion` | exact `runtimeVersion` gate + `targetAppVersions` |
| `codePush.sync()` / check | `useOtaUpdate().checkNow()` |
| `notifyAppReady()` / mandatory ready | `markHealthy()` |
| App Center / your S3+CDN | your [self-hosted backend](/docs/backend/installation) (no S3 URL on the client) |
| `appcenter codepush release-react` / hot-updater CLI | [`npx dash-ota publish`](/docs/cli/commands#publish) |

## Steps

1. **Backend:** mount [`dashOtaMiddleware`](/docs/backend/express) (or run standalone). Unlike a
   signed-S3-URL model, dash-ota streams ciphertext through the API with a one-time token.
2. **Keys + native config:** generate per-env keypairs, embed the **public key** + `runtimeVersion`
   per flavour. This is the security upgrade — bundles are verified in native, not just downloaded.
3. **Provider:** replace the CodePush/hot-updater HOC with `<DashOtaProvider>` +
   [`useOtaUpdate()`](/docs/react-native/use-ota-update).
4. **Ready signal:** replace `notifyAppReady()` / equivalent with `markHealthy()` — call it once your
   app is genuinely usable (drives the [crash-loop breaker](/docs/concepts/crash-loop)).
5. **Targeting:** map `targetBinaryVersion` to dash-ota's **`runtimeVersion`** (native-compat key);
   use `targetAppVersions` for marketing-version ranges.
6. **CLI:** swap your release command for `dash-ota publish` (encrypt + sign). Compile to **HBC**
   with your binary's `hermesc` (see [Hermes](/docs/cli/hermes)).

## What you gain over both
- **Native Ed25519 verification** + **AES-256-GCM** + **hardware device-key** auth.
- **Force-update gate** and **server-side auto-pause** built in.
- No reliance on a retiring service (CodePush) and a stronger security posture than hot-updater's
  signed-URL model.

→ [Comparison](/docs/introduction/comparison) · [Self-host the backend](/docs/guides/self-host-backend)
