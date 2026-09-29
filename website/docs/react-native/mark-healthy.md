---
sidebar_position: 8
title: markHealthy & crash-loop
---

# markHealthy and the crash-loop breaker

`markHealthy()` tells dash-ota that the bundle now running works. It ends the bundle's trial and makes
it the last-known-good bundle: the one the device goes back to if a later update fails. Until a new
bundle is marked healthy, the [crash-loop breaker](/docs/concepts/crash-loop) watches it.

## When to call it

Call `markHealthy()` once your app is actually usable, typically when the first real screen after
sign-in has rendered. Calling it as soon as JavaScript loads is too early: a bundle that loads and
then shows a blank screen should not count as healthy.

```tsx
import { useEffect } from 'react';
import { Text } from 'react-native';
import { useOtaUpdate } from 'react-native-dash-ota';

export function Dashboard() {
  const { markHealthy } = useOtaUpdate();

  useEffect(() => {
    markHealthy(); // this screen rendered, so the bundle works
  }, [markHealthy]);

  return <Text>Dashboard</Text>;
}
```

Calling it again later, or on a launch that runs the embedded bundle, does no harm.

## Or let the provider call it

For a simple app, set `autoMarkHealthyMs` and the provider calls `markHealthy()` that many
milliseconds after it mounts:

```tsx
import AsyncStorage from '@react-native-async-storage/async-storage';
import { DashOtaProvider, type OtaConfig } from 'react-native-dash-ota';
import App from './App';

const config: OtaConfig = {
  appVersion: '1.4.0',
  storage: AsyncStorage,
  getEnrollToken: async () => '<YOUR_SESSION_TOKEN>',
  autoMarkHealthyMs: 4000,
};

export default function Root() {
  return (
    <DashOtaProvider config={config}>
      <App />
    </DashOtaProvider>
  );
}
```

Pick a delay well after your app becomes usable. A timer can mark a bundle healthy even if it only
shows a blank screen, which is why calling `markHealthy()` from a real screen is the safer choice.

## What happens if you never call it

- A normal session is not held against the bundle. A launch that reaches JavaScript and then goes to
  the background (the user switching away or closing the app) is refunded, so a working bundle is not
  reverted just because `markHealthy()` was never called.
- A launch that crashes, before or after JavaScript starts, is counted. After two counted launches,
  the next launch disables the bundle on that device and goes back to the last-known-good bundle.
  The exact rules are on the [crash-loop breaker](/docs/concepts/crash-loop) page.
- The bundle never becomes last-known-good. If a later update crash-loops, the device goes back past
  it to an older update or to the embedded bundle.
- The backend never receives a `healthy` report for it, so the release shows as applied but never
  healthy in `dash-ota list`.

A disabled bundle is never downloaded again on that device. The failure is reported to the backend
on the next check, and enough failures can
[pause the release for everyone](/docs/guides/staged-rollout).

## When the `healthy` report reaches the backend

The report is sent after a check. On the launch that applied an update, that launch's check has
already used its server nonce for the `applied` report, so `healthy` is sent after the next check:
on the next launch, or when the app returns to the foreground if `checkOnAppForeground` is on. In
0.5.1 and later this also works when `markHealthy()` runs before the first check has finished; before
0.5.1 the report was never sent in that case.
