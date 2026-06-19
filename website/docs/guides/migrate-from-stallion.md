---
sidebar_position: 6
title: Migrate from Stallion
---

# Migrate from Stallion

Stallion is a managed OTA SDK. Moving to dash-ota means **taking ownership** of the backend and
release tooling, and gaining native signature verification. The client shapes are similar, so the
swap is mechanical.

## Concept mapping

| Stallion | dash-ota |
|---|---|
| `withStallion(App)` | `<DashOtaProvider config={…}>` wrapping your app |
| `useStallionUpdate()` | [`useOtaUpdate()`](/docs/react-native/use-ota-update) |
| Stallion dashboard / cloud | your [self-hosted backend](/docs/backend/installation) |
| `stallion-publish` CLI / SDK | [`npx dash-ota`](/docs/cli/overview) |
| `STALLION_*` config | native per-flavour `OTA_*` (channel, server, **public key**, runtimeVersion) |
| native `getJSBundleFile` / `bundleURL` override | `DashOtaBundleLoader.getBundleFile()` / `.bundleURL()` |

## Steps

1. **Stand up the backend** — mount [`dashOtaMiddleware`](/docs/backend/express) in an Express app
   (or run standalone). This replaces the Stallion cloud.
2. **Generate signing keys** per environment ([keygen](/docs/cli/environments-keys)) and **embed
   the public key** in each flavour — this is the new capability Stallion lacks (native-verified
   integrity).
3. **Swap the provider:** replace `withStallion`/`useStallionUpdate` with `<DashOtaProvider>` +
   `useOtaUpdate()`. The returned shape (`status`, `availableUpdate`, `applyUpdate`,
   `markHealthy`, …) is intentionally close.
4. **Swap the native hooks:** point `getJSBundleFile()` (Android) and `bundleURL()` (iOS) at
   `DashOtaBundleLoader` instead of Stallion's.
5. **Replace publish scripts:** swap `stallion-publish` for `dash-ota publish` (it signs + encrypts).
6. **Remove `STALLION_*`** env/config and the Stallion dependency.

## What you gain
- **Ed25519 signing verified in native** — a breached server can't push code.
- **AES-256-GCM** payloads, **hardware device-key** auth, **no S3 URL** on the client.
- **Force-update gate** and **server-side auto-pause**.
- Full ownership — no vendor in the bundle-push path.

## What to plan for
- You now run a backend (small, but yours). See [deployment](/docs/backend/deployment).
- You manage signing keys ([custody & rotation](/docs/cli/key-custody)).

→ [Comparison](/docs/introduction/comparison)
