---
sidebar_position: 7
title: Update modes
---

# Update modes

dash-ota supports three modes; you choose per app via config and per release via the `mandatory`
flag.

## Auto (default)
Silent: check on launch → download → native-verify → **apply on next cold start**. No user
friction. Enabled by `autoCheckOnLaunch` + `autoStage` (both default `true`).

## Manual
Drive it from your UI — e.g. a "Check for updates" button in Settings:

```tsx
const { checkNow, availableUpdate, applyUpdate } = useOtaUpdate();
// <Button title="Check for updates" onPress={checkNow} />
// {availableUpdate && <Button title="Update now" onPress={() => applyUpdate()} />}
```

Set `autoCheckOnLaunch: false` and/or `autoStage: false` to take full manual control.

## Mandatory
A release published with `--mandatory` sets `isMandatory`. Show a **blocking** "reopen the app"
prompt until the user relaunches:

```tsx
const { isMandatory, availableUpdate } = useOtaUpdate();
if (isMandatory && availableUpdate) return <MandatoryUpdateScreen />;
```

Prefer a blocking prompt over `applyUpdate(true)` — an in-process restart is best-effort on the
New Architecture.

→ [markHealthy & crash-loop](/docs/react-native/mark-healthy) · [Force-update gate](/docs/concepts/force-update)
