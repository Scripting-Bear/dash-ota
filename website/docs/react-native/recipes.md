---
sidebar_position: 11
title: Recipes
---

# Recipes

Common screens built on [`useOtaUpdate()`](/docs/react-native/use-ota-update). Each one is a
component to render somewhere inside `<DashOtaProvider>`.

## "Check for updates" in Settings

With the default `autoStage: true`, `checkNow()` also downloads and stages what it finds, so the
button only has to start a check. `ui` then shows the download and the "Restart now" step.

```tsx
import { Button, Text, View } from 'react-native';
import { useOtaUpdate } from 'react-native-dash-ota';

export function CheckForUpdates() {
  const { status, ui, checkNow } = useOtaUpdate();

  return (
    <View>
      <Button title="Check for updates" disabled={ui.busy} onPress={() => void checkNow()} />
      {ui.visible ? <Text>{ui.title}</Text> : null}
      {ui.cta ? <Button title={ui.cta} disabled={!ui.ctaEnabled} onPress={() => void ui.action()} /> : null}
      {status === 'up-to-date' && !ui.visible ? <Text>You're on the latest version.</Text> : null}
    </View>
  );
}
```

## Release notes before the restart

Release notes are set when you publish (`--release-note`) and arrive with the check, as
`availableUpdate.releaseNotes`. Show them while the update waits for a restart:

```tsx
import { Text, View } from 'react-native';
import { useOtaUpdate } from 'react-native-dash-ota';

export function PendingReleaseNotes() {
  const { ui, availableUpdate } = useOtaUpdate();
  if (ui.phase !== 'ready' || !availableUpdate?.releaseNotes) return null;

  return (
    <View>
      <Text>New in version {availableUpdate.bundleVersion}</Text>
      <Text>{availableUpdate.releaseNotes}</Text>
    </View>
  );
}
```

After the restart the provider no longer has the notes: `currentBundle` does not carry them. To show
a "What's new" screen after the update, save the notes in your own storage before the restart.

## Download only on Wi-Fi

Set `autoStage: false` in the provider config, then start the download when the device is on Wi-Fi.
This uses [`@react-native-community/netinfo`](https://github.com/react-native-netinfo/react-native-netinfo):

```tsx
import NetInfo, { NetInfoStateType } from '@react-native-community/netinfo';
import { useEffect } from 'react';
import { useOtaUpdate } from 'react-native-dash-ota';

// Render inside <DashOtaProvider config={{ ...yourConfig, autoStage: false }}>.
export function DownloadOnWifi() {
  const { status, downloadUpdate } = useOtaUpdate();

  useEffect(() => {
    if (status !== 'update-available') return;
    return NetInfo.addEventListener((state) => {
      if (state.type === NetInfoStateType.wifi && state.isConnected) void downloadUpdate();
    });
  }, [status, downloadUpdate]);

  return null;
}
```

A mandatory release still downloads straight away on any network unless you also set
`mandatory: 'announce'`.

## Show the running bundle (debug label)

```tsx
import { Text } from 'react-native';
import { useOtaUpdate } from 'react-native-dash-ota';

export function OtaDebugLabel() {
  const { channel, currentBundle } = useOtaUpdate();
  if (!currentBundle) return null;

  const bundle = currentBundle.isEmbedded
    ? 'embedded bundle'
    : `${currentBundle.bundleId} (v${currentBundle.bundleVersion})`;
  return (
    <Text>
      {channel} · {bundle}
    </Text>
  );
}
```

## Force-update gate

See [Force-update gate](/docs/concepts/force-update#render-the-gate).
