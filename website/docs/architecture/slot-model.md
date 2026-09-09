---
sidebar_position: 4
title: Slot model & atomic apply
---

# Slot model & atomic apply

Bundles live in on-disk **slots**. Applies are crash-safe so a power loss mid-apply can't leave a
half-written bundle.

## Slots

| Slot | What |
|---|---|
| `current` | the bundle the app boots from now |
| `lastKnownGood` | the last bundle that called `markHealthy()` |
| `staged` / `pending` | a verified bundle waiting to apply on next cold start |
| (embedded) | the bundle shipped in the binary — the ultimate fallback |

Plus boot-attempt counters and a `disabledBundles` list (crash-loop breaker).

## Atomic apply

Slot mutations are **crash-safe**: write to a temp path → `fsync` → atomic `rename` (same
filesystem). A commit marker lets the next launch recover to a consistent slot if power is lost
mid-apply. The app **never hot-swaps** mid-session — apply happens only on cold start.

## Which bundle boots

The native `getBundleFile()` (Android) / `bundleURL()` (iOS) hook returns the active slot's path, or
`null`/the embedded path as a fallback. This runs **before** React starts, so the choice of bundle
is made by trusted native code, not JS.

## Cleanup & retention

- **GC:** keep only `current` + `lastKnownGood`; delete superseded/failed slots and orphan temp
  files on launch.
- **Embedded-wins reset:** when a new **store build** is installed, its embedded bundle may be newer
  than a stored slot — native discards a now-stale slot so an old OTA can't run on a new binary.
- **Disk pre-check:** staging checks free space and **fails closed** on low disk.

→ [Lifecycle](/docs/concepts/lifecycle) · [Crash-loop breaker](/docs/concepts/crash-loop)

## State schema 2 (0.3.2+)

`state.json` carries `stateSchema: 2`. A state file without it is discarded on load: the embedded
bundle runs and the next check re-downloads. Slots written before schema 2 came from a resolver that
disabled them on their first boot, so they are not worth migrating.

Per-launch marks live under `launch` as `{ beaconAt, pausedAt }` (epoch milliseconds) and are reset
by the resolver at every launch. They drive attempt forgiveness in the
[crash-loop breaker](/docs/concepts/crash-loop).

GC keeps every slot the state still references — `current`, `lastKnownGood`, `pending` **and**
`staged` — and runs at startup before the bundle is selected. Two rules follow from that:

- A bundle downloaded inside the health window is no longer swept away before it can be applied.
- The crash-loop branch never deletes anything. The bundle it demotes is memory-mapped by the
  process that is running it.
