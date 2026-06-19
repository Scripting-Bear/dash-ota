---
sidebar_position: 8
title: markHealthy & crash-loop
---

# markHealthy & the crash-loop breaker

`markHealthy()` is the signal that the running bundle works. It clears the launch-attempt counter
and promotes the bundle to **last-known-good**. Until it's called, the
[crash-loop breaker](/docs/concepts/crash-loop) is armed.

## When to call it

> Call `markHealthy()` **only after your app is genuinely usable** — typically when your first
> real screen mounts *after* the auth gate — **not** merely when JS finishes loading.

A bundle that white-screens after load must still count as **unhealthy**, so the breaker can
revert it.

```tsx
function Dashboard() {
  const { markHealthy } = useOtaUpdate();
  useEffect(() => {
    markHealthy(); // we've rendered a real, usable screen
  }, [markHealthy]);
  // ...
}
```

## Or auto-promote

For simple apps, set `autoMarkHealthyMs` in [config](/docs/react-native/provider-config) to
promote automatically after a delay:

```tsx
<DashOtaProvider config={{ /* ... */ autoMarkHealthyMs: 4000 }}>
```

Choose a delay comfortably after your app becomes interactive. Manual is safer because it ties
"healthy" to *actual usability*, not a timer.

## What happens if you don't

If `markHealthy()` isn't called within N launches, native reverts to last-known-good → embedded,
disables the bad bundle (so it won't be re-downloaded), and reports the failure — which can
[auto-pause the rollout](/docs/guides/staged-rollout) for everyone.
