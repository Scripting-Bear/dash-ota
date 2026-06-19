---
sidebar_position: 3
title: Staged rollout & auto-pause
---

# Staged rollout & auto-pause

Ship to a small slice first, watch health, then ramp — with an automatic server-side safety net.

## Ramp it up
```bash
dash-ota publish --bundle-dir ./out --platform android --channel prod \
  --runtime-version auto --bundle-version 8 --rollout 5     # start at 5%
dash-ota list                                               # watch adoption/health
dash-ota rollout --bundle-id <id> --pct 25
dash-ota rollout --bundle-id <id> --pct 100
```

Rollout is **deterministic**: each install is bucketed by `hash(installId) % 100`, so a device
doesn't flip in and out of the rollout between checks.

## Auto-pause (the safety net)
The backend tracks adoption + failures per release (from `/confirm`). When the **failure rate**
crosses a threshold over enough samples, it **auto-pauses** the rollout — no new installs receive
it. Tune it:

| Config | Env | Default |
|---|---|---|
| `autoPauseFailureRate` | `OTA_AUTOPAUSE_RATE` | `0.2` |
| `autoPauseMinSamples` | `OTA_AUTOPAUSE_MIN` | `5` |

Wire `onConfirm` to alert when `autoPaused` is `true` (see [Hooks](/docs/backend/hooks)).

## Two layers of protection
- **Client-side:** the [crash-loop breaker](/docs/concepts/crash-loop) reverts a bad bundle on the
  device and reports the failure.
- **Server-side:** auto-pause stops the bleeding for everyone else once failures spike.

Together they mean a bad release self-limits even if you're asleep.

→ [Rollback](/docs/guides/rollback)
