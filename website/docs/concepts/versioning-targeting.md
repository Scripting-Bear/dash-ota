---
sidebar_position: 3
title: Versioning & targeting
description: runtimeVersion, bundleVersion, channels, targetAppVersions, rollout % — and the store-vs-OTA problem.
---

# Versioning & targeting

dash-ota decides *which* OTA reaches *which* device using two mandatory identifiers and three
optional axes — enforced **on the backend and again in native**.

## The two identifiers

### `runtimeVersion` — the native-compatibility key
Changes **only** when the native layer changes. The CLI can compute it as a **fingerprint** of
native inputs (`dash-ota fingerprint`), or you set it manually. It's baked into the binary and
stamped onto every OTA.

> **Invariant:** an OTA is applied only if its `runtimeVersion` *exactly* matches the binary's —
> enforced by the backend (won't offer) **and** native (won't apply).

### `bundleVersion` — the OTA lineage
A monotonic counter within a `runtimeVersion`. Native rejects `< current` (downgrade guard).

## The optional axes

| Axis | What it does |
|---|---|
| `channel` | dev / uat / prod lane; each build flavour embeds its own channel + signing key |
| `targetAppVersions` | semver range over your marketing/app version (limit a release to certain app builds) |
| `rollout %` | deterministic % of installs eligible (bucketed by `hash(installId) % 100`) |
| `bundleId` | direct targeting for ops |

## The matching rule (`/check`)

A device is offered the **newest** release that satisfies *all* of:

- same `channel` **and** `platform`,
- **exact `runtimeVersion`** match,
- `appVersion ∈ targetAppVersions` (if set),
- within the rollout bucket,
- `bundleVersion > current`,
- not paused / not rolled back.

…else *"no update."*

## The store-vs-OTA problem (solved by construction)

The classic OTA footgun: a JS-only update meant for a *new* native build accidentally lands on an
*older* one and crashes (it calls native APIs that don't exist). dash-ota makes this impossible:

| Step | runtimeVersion | Outcome |
|---|---|---|
| User installs **store build v1** | `R1` | device pinned to R1 |
| Native work → **store build v2** | `R2` | new installs pinned to R2 |
| JS-only fix → OTA `J3` published `rt=R2` | `R2` | offered **only to R2 devices** |
| User still on **v1** checks in (reports `R1`) | `R1` | **J3 doesn't match → not served** ✅ |
| *(optional)* JS fix also valid for v1 → publish `J3′` `rt=R1` | `R1` | served to the v1 user |

Each native generation has its **own OTA lineage**; an OTA can never land on an incompatible
binary. The **safe default is exact-match per generation**.

→ Set up channels: [Environments & flavours](/docs/react-native/environments) ·
Stage a release: [Staged rollout](/docs/guides/staged-rollout)
