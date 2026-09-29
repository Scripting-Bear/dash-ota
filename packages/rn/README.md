# react-native-dash-ota

The React Native client of [dash-ota](https://scripting-bear.github.io/dash-ota/), self-hosted
over-the-air updates. Every release is signed with an Ed25519 key you hold, and native code checks
the signature against a public key compiled into your app before anything is written, so the
update server can't ship code of its own. Updates apply on a cold start, and a bundle that crashes
on two launches is switched off and replaced by the last one that worked.

- React Native 0.79 or later, New Architecture (TurboModule). Verified on 0.79 and 0.87.
- Android (Kotlin, Tink) and iOS (Swift, CryptoKit).
- Only the JavaScript changes over the air; native code needs a store release.

Docs: https://scripting-bear.github.io/dash-ota/ — start with
[Ship your first update](https://scripting-bear.github.io/dash-ota/docs/getting-started/quickstart).

## Install

```sh
npm install react-native-dash-ota @react-native-async-storage/async-storage
cd ios && pod install
```

Then add the native settings (channel, server URL, public key, runtime version) and one line each
in `MainApplication.kt` and `AppDelegate.swift`. Both are shown step by step in the
[quickstart](https://scripting-bear.github.io/dash-ota/docs/getting-started/quickstart#4-wire-the-native-side).
You also need a backend (`@dash-ota/backend`) and the CLI (`@dash-ota/cli`) to publish.

## Use

```tsx
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect } from 'react';
import { ActivityIndicator, Button, Text, View } from 'react-native';
import { DashOtaProvider, useOtaUpdate } from 'react-native-dash-ota';

export default function Root() {
  return (
    <DashOtaProvider
      config={{
        appVersion: '1.4.0',
        storage: AsyncStorage,
        getEnrollToken: async () => '<YOUR_SESSION_TOKEN>', // what your backend's verifyEnrollToken checks
        checkOnAppForeground: true,
      }}
    >
      <UpdateRow />
    </DashOtaProvider>
  );
}

function UpdateRow() {
  const { ui, markHealthy } = useOtaUpdate();

  // Call it once your app is really usable; it ends the new bundle's trial.
  useEffect(() => {
    markHealthy();
  }, [markHealthy]);

  // `ui` is the announce → download → restart flow, already worked out.
  if (!ui.visible) return null;
  return (
    <View>
      <Text>{ui.title}</Text>
      <Text>{ui.description}</Text>
      {ui.busy ? <ActivityIndicator /> : null}
      {ui.cta ? <Button title={ui.cta} disabled={!ui.ctaEnabled} onPress={() => void ui.action()} /> : null}
    </View>
  );
}
```

`uiCopy` changes the wording per phase (`{version}` is filled in). `ui.blocking` is true while a
verified mandatory update is waiting; show the same content as a modal the user can't dismiss. The
raw state and actions (`status`, `availableUpdate`, `checkNow`, `downloadUpdate`, `applyUpdate`,
`rollback`) are there for other flows. See [the docs](https://scripting-bear.github.io/dash-ota/docs/react-native/use-ota-update).

## License

MIT
