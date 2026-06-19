---
sidebar_position: 4
title: Rolling back a release
---

# Rolling back a release

When a release is bad, you have three levers — two automatic, one manual.

## Manual rollback
```bash
dash-ota pause    --bundle-id <id>   # stop new installs immediately
dash-ota rollback --bundle-id <id>   # flag the release (paused + rolled-back)
```
New checks won't be offered the release. Devices already on it revert to last-known-good on their
next crash/health failure, or you can prompt users to relaunch.

## Automatic — client side
The [crash-loop breaker](/docs/concepts/crash-loop) reverts a bundle that crashes (or never calls
`markHealthy()`) to last-known-good → embedded, **on the device**, and disables it so it won't be
re-downloaded.

## Automatic — server side
[Auto-pause](/docs/guides/staged-rollout) stops the rollout for everyone once the failure rate
spikes.

## What "revert" means
dash-ota keeps `current` + `lastKnownGood` slots. A rollback swaps back to last-known-good; if that
also fails, it falls to the **embedded** bundle (the one shipped in the binary, guaranteed to match
native). The app always boots to something that runs.

## Downgrade safety
Native enforces a **monotonic `bundleVersion`** — an attacker can't replay an old (validly-signed)
bundle as a "downgrade attack." A legitimate rollback is an explicit, server-driven action, not a
silently-served older bundle.
