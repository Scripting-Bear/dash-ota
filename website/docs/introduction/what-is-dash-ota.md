---
sidebar_position: 1
slug: /
title: What is dash-ota?
description: A self-hosted, security-hardened over-the-air update system for React Native — client, CLI, and backend, all owned by you.
---

# What is dash-ota?

**dash-ota** is a custom, self-hosted, **security-hardened over-the-air (OTA) update system for
React Native**. It lets you ship JavaScript-bundle updates to your app **without an app-store
round-trip** — and unlike a managed SDK, **you own every piece**: the client library, the
release tooling, and the backend.

It was built for a financial-grade app where a third party holding "the keys to push code to
production" is unacceptable. So the design starts from a hard security bar and works backward.

## The one guarantee that matters

> **A fully breached backend still cannot push malicious code to your users.**

Every update manifest is **signed with an Ed25519 key in the CLI** (which runs in your CI), and
**verified in native** against a public key **baked into the app binary**. The backend only ever
stores and serves *pre-signed* data — it never possesses the signing key. This is the
expo-updates code-signing model, and it holds **even if TLS is completely broken**.

## Three packages, one workflow

| Package | What it is |
|---|---|
| [`react-native-dash-ota`](/docs/react-native/installation) | The **client**: one `<DashOtaProvider>` + `useOtaUpdate()` hook over native Android/iOS. Verifies, decrypts, applies, and rolls back — all in native. |
| [`@dash-ota/cli`](/docs/cli/overview) | The **release tooling** (`npx dash-ota`). Bundles, encrypts, **signs**, publishes, and operates rollouts. Holds the private key (CI only). |
| [`@dash-ota/backend`](/docs/backend/installation) | The **distributor**. Mounts into any Express/Connect app as one middleware, or runs standalone. Never holds the signing key. |
| `@dash-ota/shared` | The internal crypto/protocol core. You rarely depend on it directly. |

## What you get

- 🛡️ **Native-verified integrity** — Ed25519 signatures checked before any bundle runs.
- 🔐 **Authenticated, encrypted delivery** — AES-256-GCM payloads, hardware **device-key**
  request auth (no shared secret at enrollment), nonce + timestamp anti-replay.
- 🎯 **Precise targeting** — exact `runtimeVersion` gate, `bundleVersion` downgrade guard,
  `channel` (dev/uat/prod), `targetAppVersions`, and staged **`rollout %`**.
- 🔄 **Fail-closed reliability** — atomic apply on cold start, a **crash-loop circuit breaker**
  that always boots your app to *something* that runs, and server-side auto-pause.
- 🚪 **Force-update gate** — push users to the store when a native fix is required.
- 🧩 **Plug-and-play & config-driven** — the backend is one middleware; the client is one
  provider; the CLI is one `npx` command.

## Who it's for

Teams that need OTA updates but want **ownership and a defensible security model** — fintech,
healthcare, enterprise, or anyone uncomfortable handing bundle-push rights to a SaaS. It targets
**React Native 0.79+, New Architecture, Hermes**, on **Android and iOS**.

## How it compares

dash-ota is deliberately stronger on the security model than Stallion, hot-updater, or even
CodePush. See the [head-to-head comparison →](/docs/introduction/comparison)

## Next steps

- [Architecture overview](/docs/introduction/architecture) — how the three packages divide trust
- [Quickstart](/docs/getting-started/quickstart) — your first OTA, end to end
- [Security model](/docs/concepts/security-model) — the full threat model
