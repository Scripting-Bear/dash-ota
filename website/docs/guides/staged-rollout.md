---
sidebar_position: 3
title: Staged rollout & auto-pause
---

# Staged rollout & auto-pause

Ship to a small share of devices first, watch how it does, then widen it.

## Ramp it up

```bash
npx dash-ota publish --bundle-dir ./ota-out/android --app-id com.example.app \
  --platform android --channel prod --key-id key_prod_1 \
  --runtime-version rt1 --bundle-version 8 --rollout 5     # start at 5%
npx dash-ota list                                          # watch the adoption column
npx dash-ota rollout --bundle-id <BUNDLE_ID> --pct 25
npx dash-ota rollout --bundle-id <BUNDLE_ID> --pct 100
```

Which devices are in is fixed per release: each install gets a bucket from 0 to 99, computed from
its install id and the release's `bundleId`, and it's in when its bucket is below the percentage.
A device doesn't drop in and out between checks, raising the percentage only adds devices, and
each release picks a different 5%.

## Auto-pause

Devices report what happened to a release: `applied`, `healthy`, `failed` (the crash-loop breaker
reverted it) and `rolled_back` (the app called `rollback()`). The backend counts reports, not
devices. Once a release has enough reports and a high enough share of them are `failed` or
`rolled_back`, it pauses the release, so no new devices get it.

| Config | Env | Default |
|---|---|---|
| `autoPauseFailureRate` | `OTA_AUTOPAUSE_RATE` | `0.2` |
| `autoPauseMinSamples` | `OTA_AUTOPAUSE_MIN` | `5` |

An auto-pause is an ordinary pause: `list` shows `PAUSED`, and `pause --resume` lifts it. Each
install counts at most once towards the failures of a release (backend 0.5.1 and later), so one
device can't pause a release on its own.

To hear about it, use the `onConfirm` hook, which receives every report including an `autoPaused`
flag. See [Hooks](/docs/backend/hooks).

## Two layers

- On the device, the [crash-loop breaker](/docs/concepts/crash-loop) takes a crashing bundle off
  that device and reports the failure.
- On the server, auto-pause stops everyone else getting a release once the failures add up.

Neither needs you to be watching. Neither fixes devices that already run the release, apart from
the ones that crash; for those, publish a fix. See [Rollback](/docs/guides/rollback).
