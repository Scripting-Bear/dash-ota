---
sidebar_position: 7
title: Migrate from CodePush / hot-updater
---

# Migrate from CodePush / hot-updater

App Center, which hosted CodePush, was retired on 31 March 2025, and the old `appcenter codepush`
CLI no longer works. Microsoft open-sourced a standalone `code-push-server`, whose repository was
archived in May 2025. hot-updater is a popular self-hosted replacement. This page maps both to
dash-ota and lists what behaves differently.

## Concept mapping

| CodePush / hot-updater | dash-ota |
|---|---|
| `codePush(App)` / hot-updater's `wrap()` | `<DashOtaProvider config={…}>` |
| deployment keys / `channel` | `channel`, compiled into each build flavour |
| `targetBinaryVersion` / `targetAppVersion` | exact `runtimeVersion` gate + `targetAppVersions` |
| `codePush.sync()` / check | `useOtaUpdate().checkNow()` |
| `notifyAppReady()` (which `sync()` calls for you) / hot-updater's confirm on first render | `markHealthy()`, which nothing calls for you unless you set `autoMarkHealthyMs` |
| `InstallMode.IMMEDIATE` / `InstallMode.ON_NEXT_RESUME` | no equivalent: an update applies on the next cold start, or right away when you call `applyUpdate(true)` |
| `code-push-server` / your storage provider | your [self-hosted backend](/docs/backend/installation) (no storage URL on the client) |
| `code-push-standalone release-react` / hot-updater CLI | [`dash-ota publish`](/docs/cli/commands#publish), from `@dash-ota/cli` |

## Steps

1. **Backend:** mount [`dashOtaMiddleware`](/docs/backend/express) (or run it standalone). Unlike
   a signed-URL model, dash-ota streams blobs through your API. The device gets a download token
   scoped to one release, sent in a header and reusable for 30 minutes by default.
2. **Keys and native config:** install the CLI (`npm i -D @dash-ota/cli`), run
   `npx dash-ota keygen` once per environment, and embed each **public key** and the
   `runtimeVersion` in the matching build flavour. If you signed CodePush or hot-updater bundles,
   this key replaces that one. If you didn't, it's new: dash-ota has no unsigned mode, so it
   won't publish without a key.
3. **Provider:** replace the CodePush or hot-updater wrapper with `<DashOtaProvider>` +
   [`useOtaUpdate()`](/docs/react-native/use-ota-update).
4. **Ready signal:** call [`markHealthy()`](/docs/react-native/mark-healthy) once your first real
   screen works. CodePush's `sync()` called `notifyAppReady()` for you and hot-updater confirms on
   first render; dash-ota doesn't, unless you set `autoMarkHealthyMs`. A normal session (the app
   reaches JavaScript, then goes to the background) isn't counted against a bundle, but a bundle
   that crashes after reaching JavaScript is. See the [crash-loop breaker](/docs/concepts/crash-loop).
5. **Install modes:** drop `IMMEDIATE` and `ON_NEXT_RESUME`. By default a downloaded update runs
   on the next cold start; call `applyUpdate(true)` to restart into it now.
6. **Targeting:** map `targetBinaryVersion` to dash-ota's **`runtimeVersion`**, the value that
   says which native build a bundle is compatible with. Use `targetAppVersions` for
   marketing-version ranges.
7. **CLI:** replace your release command with `dash-ota publish`. It needs `--bundle-dir` and
   `--app-id`, encrypts and signs the release, and uploads it. Compile to Hermes bytecode with
   your binary's `hermesc` (see [Hermes](/docs/cli/hermes)).

## What changes

- Signing can't be switched off, and every release is verified in native code before it's
  written to disk. CodePush and hot-updater support signing too, but as an opt-in.
- Requests are signed with a per-install device key, with a timestamp and a nonce the server
  won't accept twice.
- The server pauses a release on its own when devices report failures, and the backend has a
  force-update gate for sending users to the store.
- There's no vendor service to depend on. With CodePush the choice is now an archived server you
  run yourself.

## What you give up

- **Patches.** hot-updater ships binary patches. dash-ota skips unchanged files, but a changed JS
  bundle downloads whole.
- **CDN delivery.** Every blob goes through your API instead of a bucket or CDN.
- **Switching deployments at runtime.** CodePush's `deploymentKey` option and hot-updater's
  runtime channel switch have no equivalent; the channel is compiled into the binary.
- **Built-in crash tooling.** hot-updater has `withSentry()` for source maps; dash-ota leaves
  source maps to you.

→ [Comparison](/docs/introduction/comparison) · [Self-host the backend](/docs/backend/deployment)
