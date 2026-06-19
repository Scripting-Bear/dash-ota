---
sidebar_position: 11
title: Recipes
---

# Recipes

Common UI patterns built on [`useOtaUpdate()`](/docs/react-native/use-ota-update).

## "Check for updates" in Settings

```tsx
function CheckForUpdates() {
  const { status, availableUpdate, checkNow, applyUpdate } = useOtaUpdate();
  return (
    <Row>
      <Button title="Check for updates" onPress={checkNow} disabled={status === 'checking'} />
      {availableUpdate && <Button title="Update now" onPress={() => applyUpdate()} />}
      {status === 'up-to-date' && <Text>You're up to date.</Text>}
    </Row>
  );
}
```

## "What's New" sheet

```tsx
const { availableUpdate } = useOtaUpdate();
// availableUpdate?.releaseNotes — render in a bottom sheet after a successful apply
```

## Wifi-only / consent gate for large downloads

Set `autoStage: false`, then stage only when on wifi (or after consent):

```tsx
const { availableUpdate, checkNow } = useOtaUpdate();
// on a "Download update" press, or when NetInfo reports wifi, call applyUpdate()/checkNow()
```

## Show the active channel/version (debug overlay)

```tsx
const { channel, currentBundle } = useOtaUpdate();
// <Text>{channel} · v{currentBundle?.bundleVersion}{currentBundle?.isEmbedded ? ' (embedded)' : ''}</Text>
```

## Force-update gate

See [Force-update UI](/docs/react-native/force-update-ui).
