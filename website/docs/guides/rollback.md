---
sidebar_position: 4
title: Rolling back a release
---

# Rolling back a release

When a release is bad, three things can stop it: two run on their own, and one is you.

## By hand

```bash
npx dash-ota pause    --bundle-id <BUNDLE_ID>   # stop offering it; undo with --resume
npx dash-ota rollback --bundle-id <BUNDLE_ID>   # stop offering it for good
```

Either one stops the release reaching more devices, and a download already in progress fails with
`410`. Neither reaches devices that already installed it: they keep running it until one of these
happens:

- they're offered a newer release, so publish a fixed one with a higher `--bundle-version`;
- the bundle crash-loops and the breaker reverts it (below);
- your app calls `rollback()` from `useOtaUpdate()`, for example from a hidden support menu.

Relaunching the app doesn't revert anything. There is no command that tells devices to go back.

`rollback` can't be undone: `pause --resume` lifts the pause but not the rolled-back flag. If you
might want the release back, use `pause`.

## On the device: the crash-loop breaker

A new bundle runs on trial. If it crashes on two cold starts before it's marked healthy, the device
switches it off (it won't be downloaded again) and goes back to the last bundle that worked, or to
the one shipped inside the app if there is none. From 0.5.1, if that fallback also crash-loops, the
device ends up on the shipped bundle. The device then reports the failure to the server. See
[Crash-loop breaker](/docs/concepts/crash-loop).

## On the server: auto-pause

Devices report `applied`, `healthy`, `failed` and `rolled_back`. Once a release has at least 5
reports and 20% or more of them are `failed` or `rolled_back`, the backend pauses it. It's an
ordinary pause, so `pause --resume` lifts it. See [Staged rollouts](/docs/guides/staged-rollout).

## Older releases coming back

The device refuses a release whose `bundleVersion` isn't higher than the one it's running now.
That comparison is with the running bundle only; nothing is remembered. After a store update, a
`rollback()` or a crash-loop revert, the device runs a lower version, so an older release you
signed can install again if the server offers it. An honest server won't offer a rolled-back
release, but one that has been broken into can. See [If your update server is breached](/docs/security/breach).
