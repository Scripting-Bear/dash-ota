---
sidebar_position: 7
title: Update modes
---

# Update modes

There are three ways updates can reach users. Automatic and manual are chosen in the provider config;
mandatory is set per release when you publish.

## Automatic (the default)

With `autoCheckOnLaunch` and `autoStage` both left at their default of `true`, the provider checks on
launch, downloads and verifies any update, and stages it. The update runs from the next cold start
(the next time the app process starts from nothing). Nothing is shown to the user unless you render
`ui`.

## Manual

Set `autoStage: false` to decide when an update downloads, for example from a "Check for updates"
screen in your settings. A check then stops at status `update-available`, and nothing downloads until
you call `downloadUpdate()` or `ui.action()`. In this mode `checkNow()` never downloads, and
`applyUpdate()` only applies an update that has already been downloaded. Add
`autoCheckOnLaunch: false` if the check itself should also wait for the user.

```tsx
import { Button, Text, View } from 'react-native';
import { useOtaUpdate } from 'react-native-dash-ota';

// Render inside <DashOtaProvider config={{ ...yourConfig, autoStage: false }}>.
export function ManualUpdates() {
  const { status, availableUpdate, checkNow, downloadUpdate, applyUpdate } = useOtaUpdate();
  const busy = status === 'checking' || status === 'downloading';

  return (
    <View>
      <Button title="Check for updates" disabled={busy} onPress={() => void checkNow()} />
      {status === 'update-available' && availableUpdate ? (
        <Button
          title={`Download version ${availableUpdate.bundleVersion}`}
          onPress={() => void downloadUpdate()}
        />
      ) : null}
      {status === 'apply-pending' ? (
        <Button title="Restart now" onPress={() => void applyUpdate(true)} />
      ) : null}
      {status === 'up-to-date' ? <Text>You're on the latest version.</Text> : null}
    </View>
  );
}
```

`ui.action()` does the same three steps for you; this version shows which call does what.

Mandatory releases are the exception. With the default `mandatory: 'auto-download'`, a release
published with `--mandatory` downloads even when `autoStage` is `false`. Set `mandatory: 'announce'`
to treat it like any other update.

## Mandatory

`dash-ota publish --mandatory` marks a release as mandatory inside its signed manifest. On the device:

- `availableUpdate.mandatory` and `isMandatory` become `true` when a check offers it, and
  `ui.blocking` is `true` while it downloads and once it is staged.
- The flag is read from the check response before native code has verified the signature. In 0.5.1
  and later, if the download or verification fails, or the crash-loop breaker already disabled that
  bundle on this device, `isMandatory` and `ui.blocking` go back to `false`. Only a verified, staged
  mandatory update keeps blocking. Before 0.5.1 they stayed `true` after a failure, which could leave
  a blocking screen up with nothing to install.

Base a blocking screen on `ui.blocking`, not on `isMandatory` and `availableUpdate`. Because
`ui.blocking` clears when the update fails, a screen built this way lets the user back into the app
instead of trapping them:

```tsx
import type { ReactNode } from 'react';
import { ActivityIndicator, Button, Modal, Text, View } from 'react-native';
import { useOtaUpdate } from 'react-native-dash-ota';

export function MandatoryUpdateGate({ children }: { children: ReactNode }) {
  const { ui } = useOtaUpdate();

  return (
    <>
      {children}
      <Modal visible={ui.visible && ui.blocking} animationType="fade" onRequestClose={() => {}}>
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24 }}>
          <Text>{ui.title}</Text>
          <Text>{ui.description}</Text>
          {ui.busy ? <ActivityIndicator /> : null}
          {ui.cta ? <Button title={ui.cta} disabled={!ui.ctaEnabled} onPress={() => void ui.action()} /> : null}
        </View>
      </Modal>
    </>
  );
}
```

The empty `onRequestClose` stops the Android back button from closing the modal. In the `ready`
phase, `ui.action()` calls `applyUpdate(true)`: Android relaunches the app, and iOS reloads it in the
same process. With a client before 0.5.1, that iOS reload still ran the old bundle, so an app on an
older client should ask iOS users to close and reopen the app instead.

A mandatory OTA release is not the same as the [force-update gate](/docs/concepts/force-update),
which sends users to the store for a new native build.

→ [markHealthy & crash-loop](/docs/react-native/mark-healthy) · [Force-update gate](/docs/concepts/force-update)
