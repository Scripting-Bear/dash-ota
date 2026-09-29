---
sidebar_position: 6
title: Migrate from Stallion
---

# Migrate from Stallion

Stallion is a managed OTA service with an open-source SDK and CLI. Moving to dash-ota means you
run the backend and the release tooling yourself. Stallion already offers bundle signing as an
opt-in; in dash-ota it's mandatory. The client APIs differ, so plan to rewrite the code that reads
update state rather than rename it.

## Concept mapping

| Stallion | dash-ota |
|---|---|
| `withStallion(App)` | `<DashOtaProvider config={…}>` wrapping your app |
| `useStallionUpdate()` | [`useOtaUpdate()`](/docs/react-native/use-ota-update) |
| `isRestartRequired` | `status === 'apply-pending'` |
| `currentlyRunningBundle` | `currentBundle` |
| `newReleaseBundle` | `availableUpdate` |
| `restart()` | `applyUpdate(true)` |
| no equivalent | `markHealthy()`, which ends the new bundle's trial (see below) |
| Stallion dashboard / cloud | your [self-hosted backend](/docs/backend/installation) and the local [dashboard](/docs/cli/dashboard) |
| `stallion publish-bundle` (npm `stallion-cli`) | `dash-ota publish` (npm [`@dash-ota/cli`](/docs/cli/overview)) |
| `StallionProjectId`, `StallionAppToken`, `StallionPublicSigningKey` in `strings.xml` / `Info.plist` | Android string resources `ota_channel`, `ota_server_url`, `ota_public_keys`, `ota_runtime_version` and integer `ota_native_build`; iOS `Info.plist` keys `OTA_CHANNEL`, `OTA_SERVER_URL`, `OTA_PUBLIC_KEYS`, `OTA_RUNTIME_VERSION` |
| native `getJSBundleFile` / `bundleURL` override | `DashOtaBundleLoader.getBundleFile(applicationContext)` / `DashOtaBundleLoader.bundleURL()` |

## Steps

1. **Stand up the backend.** Mount [`dashOtaMiddleware`](/docs/backend/express) in an Express app,
   or run it standalone. This replaces the Stallion cloud.
2. **Generate signing keys** per environment ([keygen](/docs/react-native/environments)) and
   **embed the public key** in each flavour. If you used Stallion's bundle signing, this key
   replaces `StallionPublicSigningKey`. dash-ota has no unsigned mode, so it won't publish without
   a key.
3. **Swap the provider.** Replace `withStallion` and `useStallionUpdate` with `<DashOtaProvider>` and
   `useOtaUpdate()`, using the mapping above.
4. **Add a ready signal.** Stallion has none, so this is new code. A new bundle runs on trial
   until your app calls [`markHealthy()`](/docs/react-native/mark-healthy); call it once the first
   real screen works. Nothing calls it for you unless you set `autoMarkHealthyMs`. See the
   [crash-loop breaker](/docs/concepts/crash-loop).
5. **Swap the native hooks.** Point Android's bundle file and iOS's `bundleURL()` at
   `DashOtaBundleLoader` instead of Stallion's loader. The exact edit depends on your React Native
   template; see [Android setup](/docs/react-native/android-setup) and
   [iOS setup](/docs/react-native/ios-setup).
6. **Replace publish scripts.** Swap `stallion publish-bundle` for `dash-ota publish`, which needs
   `--bundle-dir` and `--app-id` and encrypts and signs the release.
7. **Remove Stallion.** Delete the `Stallion*` entries from `strings.xml` and `Info.plist`, and
   the Stallion dependency.

## What changes

- Signing can't be switched off, and every release is verified in native code before it's
  written to disk.
- Requests are signed with a per-install device key, with a timestamp and a nonce the server
  won't accept twice.
- Blobs are encrypted with AES-256-GCM by default and stream through your API; the client never
  sees a storage URL.
- The server pauses a release on its own when devices report failures. In Stallion, pausing is
  a manual action in the dashboard.
- There's no vendor in the path between your CI and your users' devices.

## What you give up

- A hosted service, with a free tier up to 10K monthly active users, and vendor support.
- Patches: Stallion's Pro plan and up ship diffs that are much smaller than a full bundle.
  dash-ota skips unchanged files, but a changed JS bundle downloads whole.
- The in-app testing modal. In dash-ota the channel is compiled into the binary, so testing
  another channel means installing another build.
- React Native versions below 0.79. Stallion supports 0.69 and later.

## What to plan for

- You now run a backend (small, but yours). See [deployment](/docs/backend/deployment).
- You manage signing keys ([custody and rotation](/docs/security/key-management)).

→ [Comparison](/docs/introduction/comparison)
