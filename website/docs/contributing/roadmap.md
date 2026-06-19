---
sidebar_position: 2
title: Roadmap
---

# Roadmap

dash-ota's core is shipped and published. These are the deferred, documented, non-blocking
enhancements.

## Security plug-ins
- **TLS certificate/public-key pinning** (`TransportSecurity`) — closes active-MITM confidentiality.
- **Device attestation** (Play Integrity / App Attest, `IntegrityAttestor`) — both are modular
  interfaces the core already exposes. → [Pinning & attestation](/docs/security/pinning-attestation)

## Backend
- First-class **Postgres + Redis + object-storage** store implementations (the interface exists today).
- A **Fastify/Koa** adapter package (the route core is already framework-agnostic).

## Tooling & ops
- **Source-map upload** baked into `dash-ota publish` (Crashlytics/Sentry, keyed by debugId).
- **Differential (bsdiff) patches** to shrink downloads (the manifest already allows it).
- A **local web console** (CRM) over the backend admin API for rollout/health visualization.

## Platform
- iOS **Xcode scheme/config** generators for dev/uat/prod (the xcconfig pattern is documented).
- Broader RN version matrix as the New Architecture stabilizes downstream.

## Docs
- Auto-generated **API reference** (TypeDoc) alongside these hand-written guides.

Have a need that's not here? Open an issue on
[GitHub](https://github.com/Scripting-Bear/dash-ota/issues).
