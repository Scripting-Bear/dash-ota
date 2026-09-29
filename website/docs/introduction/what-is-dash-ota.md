---
sidebar_position: 1
slug: /
title: What is dash-ota?
description: A self-hosted over-the-air update system for React Native with mandatory release signing. You run the client library, the CLI and the backend.
---

# What is dash-ota?

dash-ota is a self-hosted over-the-air (OTA) update system for React Native. An OTA update
replaces your app's JavaScript bundle on users' devices without a new app-store release. You run
all of it yourself: the client library in your app, the CLI that builds and signs releases, and
the backend that serves them.

It was built for a financial app where a third party able to push code to production was not
acceptable, so the design starts from what happens when the update server is compromised.

New to OTA updates? Read [If you've never shipped an OTA update](/docs/getting-started/what-is-an-ota-update)
first.

## What a hacked server can't do

A fully breached backend cannot ship code of its own to your users.

The CLI signs every release manifest with an Ed25519 private key, in your CI or on your release
machine. The manifest lists every file in the release with its SHA-256 hash. Native code in the
app checks that signature against public keys compiled into the app binary, and writes nothing
until it verifies. The backend only stores and serves releases that were signed before they
reached it, and never has the private key. This follows the code-signing model of `expo-updates`,
and it holds even if TLS is broken.

A breached backend can still do some harm: hold back updates, re-serve an older release you
signed in some cases, read your bundles, and send a hard force-update prompt that your app may
render as a blocking screen. The [breach walkthrough](/docs/security/breach) lists each case.

## The packages

| Package | What it is |
|---|---|
| [`react-native-dash-ota`](/docs/react-native/installation) | The client: a `<DashOtaProvider>` and a `useOtaUpdate()` hook over native Android and iOS code. Verification, decryption, applying and rollback all run in native code. |
| [`@dash-ota/cli`](/docs/cli/overview) | The release tooling. Its command is `dash-ota`. It bundles, encrypts, signs and publishes releases, and pauses or rolls them back. It reads the signing key, so it runs in CI or on a release machine. |
| [`@dash-ota/backend`](/docs/backend/installation) | The server that distributes releases. Mount it in an Express or Connect app as one middleware, or run it standalone. It never holds the signing key. |
| `@dash-ota/shared` | The crypto and protocol code the others share. You rarely depend on it directly. |

## What it does

- Checks the Ed25519 signature and every file's SHA-256 hash in native code before a bundle runs.
  There is no unsigned mode.
- Encrypts each file with AES-256-GCM. This keeps blobs unreadable to someone who can read only
  your storage; the backend and enrolled devices can decrypt them.
- Signs every request with a per-install device key (Android Keystore, or the Secure Enclave on
  iOS with a software fallback by default), plus a timestamp and a nonce the server won't accept
  twice.
- Targets releases by an exact `runtimeVersion`, `channel` (dev, uat or prod), `targetAppVersions`
  and a rollout percentage, and refuses a `bundleVersion` that isn't higher than the bundle the
  device is running.
- Applies an update on the next cold start and keeps it on trial until your app calls
  `markHealthy()`. If a bundle keeps crashing, the device disables it and goes back to the last
  working bundle or the one compiled into the app. The server pauses a release when enough
  devices report failures.
- Tells your app when a native update is required, so you can send users to the store.

## Who it's for

Teams that need OTA updates and want to own the whole pipeline, with a security model they can
explain to an auditor. It targets React Native 0.79 and later, with the New Architecture and
Hermes, on Android and iOS.

## How it compares

Stallion, hot-updater, CodePush and EAS Update can all sign bundles too. In dash-ota signing can't
be switched off, and the comparison page covers the other differences, including
[where the others are ahead](/docs/introduction/comparison#where-the-others-are-ahead).

## Next steps

- [Prerequisites](/docs/getting-started/prerequisites): what your app and server need
- [Architecture overview](/docs/introduction/architecture): how the three packages divide trust
- [Quickstart](/docs/getting-started/quickstart): your first OTA update, end to end
- [Security model](/docs/concepts/security-model): the full threat model
