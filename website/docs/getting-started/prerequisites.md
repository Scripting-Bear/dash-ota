---
sidebar_position: 1
title: Prerequisites
---

# Prerequisites

dash-ota targets modern React Native and a Node backend.

## App (client)

- **React Native 0.79+** with the **New Architecture enabled** (TurboModules/Fabric).
- **Hermes** enabled (the default). OTA bundles are shipped as Hermes bytecode (HBC).
- **Android** minSdk **24+** (the example uses 29). **iOS 16+**.
- A storage adapter for a stable install id — e.g. `@react-native-async-storage/async-storage`,
  `react-native-mmkv`, or any secure storage. You inject it via config.

## Release tooling (CLI)

- **Node 18+** (for `npx dash-ota`).
- The **same `hermesc`** that ships in your app binary, to compile OTA bundles to matching HBC
  (the CLI's `bundle`/publish flow and the example's `publish-ota.mjs` handle this).

## Backend

- **Node 18+**. Express is optional (the middleware works with any Connect-style framework, or
  standalone via `node:http`).
- For production: a place to store ciphertext (filesystem for the POC; object storage later) and
  release/install metadata (JSON for the POC; Postgres/Redis later).

## Knowledge

You don't need to be a crypto expert — the trust-critical work is in native and the CLI. But
skimming [Core Concepts](/docs/concepts/lifecycle) (especially `runtimeVersion`) will save you
debugging time.

Next: [Quickstart →](/docs/getting-started/quickstart)
