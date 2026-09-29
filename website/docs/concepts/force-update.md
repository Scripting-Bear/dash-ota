---
sidebar_position: 6
title: Force-update gate
description: Send users to the store when a fix needs a new binary, which an OTA update can't deliver.
---

# Force-update gate

An OTA update changes JavaScript, not native code. When a fix needs a new binary (a native
dependency, a TurboModule change, a security patch in native code), people have to get it from the
store. The force-update gate is how dash-ota tells an app its binary is too old.

## How it works

Every `/check` returns a native-version policy for the channel, alongside the update itself:

```json
{
  "nativePolicy": {
    "minSupportedNativeVersion": 42,
    "severity": "hard",
    "storeUrl": "https://apps.apple.com/app/id..."
  }
}
```

The client surfaces it as `useOtaUpdate().nativePolicy`, with `severity` resolved server-side
against the running binary's build number:

| `severity` | Meaning | What to render |
|---|---|---|
| `none` | the binary meets the minimum | nothing |
| `soft` | below the minimum | a dismissible nudge |
| `hard` | too old to support | a blocking screen |

The gate and OTA coexist. A binary that meets the minimum keeps receiving JS updates as normal;
only the too-old ones are sent to the store.

## Set the policy

```bash
npx dash-ota native-policy --channel prod --min 42 --severity soft
```

`--min` is the lowest native build number you still support. It's compared with the build number
compiled into the app: `ota_native_build` on Android, `CFBundleVersion` on iOS. Note the defaults:
without `--channel` and `--severity`, the policy goes to `dev` with severity `hard`.

`--store-url` exists for clients older than 0.5.0, which open the server's link. Clients from 0.5.0
ignore it and use the link in their own config.

## Render the gate

dash-ota draws nothing; it gives you the policy and you decide what the user sees.

Give the provider your store listing. The client never uses a link from the server (see the warning
below), so without this the gate has nowhere to send people:

```tsx title="App.tsx"
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import { DashOtaProvider } from 'react-native-dash-ota';

export default function App() {
  return (
    <DashOtaProvider
      config={{
        appVersion: '1.0.0',
        storage: AsyncStorage,
        getEnrollToken: async () => '<YOUR_ENROLL_TOKEN>',
        storeUrl: Platform.select({
          ios: 'itms-apps://apps.apple.com/app/id<YOUR_APP_STORE_ID>',
          default: 'market://details?id=<YOUR_APPLICATION_ID>',
        }),
      }}
    >
      <ForceUpdateGate>
        <YourApp />
      </ForceUpdateGate>
    </DashOtaProvider>
  );
}
```

`storeUrl` must start with `https://`, `market://` or `itms-apps://`. Anything else is dropped, with
an error in the log.

```tsx title="ForceUpdateGate.tsx"
import type { ReactNode } from 'react';
import { Button, Linking, Text, View } from 'react-native';
import { useOtaUpdate } from 'react-native-dash-ota';

export function ForceUpdateGate({ children }: { children: ReactNode }) {
  const { nativePolicy } = useOtaUpdate();
  const openStore = () => {
    if (nativePolicy?.storeUrl) void Linking.openURL(nativePolicy.storeUrl);
  };

  if (nativePolicy?.severity === 'hard') {
    return (
      <View>
        <Text>Update required</Text>
        <Text>This version is no longer supported. Update from the store to continue.</Text>
        <Button title="Update" onPress={openStore} />
      </View>
    );
  }

  return (
    <>
      {nativePolicy?.severity === 'soft' ? (
        <View>
          <Text>A new version is available.</Text>
          <Button title="Update" onPress={openStore} />
        </View>
      ) : null}
      {children}
    </>
  );
}
```

`YourApp` stands for your existing root component; style the two views as you like.
`nativePolicy.storeUrl` is always your `config.storeUrl`, never the server's.

:::warning[The policy isn't signed]
`nativePolicy` sits next to the signed manifest in the `/check` response, not inside it, so it's
whatever the server says.

The store link is handled for you: the client ignores any link the server sends and uses your
`config.storeUrl`. If you haven't set a valid one and the server sends a link, the client logs a
warning saying so. No check on a URL's scheme could tell your listing apart from an attacker's
`https://` page, so the server doesn't get a say.

`severity` and `minSupportedNativeVersion` are still the server's word. Someone who controls the
backend, or its admin token, can send `severity: "hard"` to every install. With a gate like the one
above, that locks users out of the app on every launch where the check succeeds. It isn't stored on
the device, so the app works again offline or once the policy is fixed. It can't send anyone
anywhere or run code; it can stop people using the app. If that risk matters more to you than an old
build staying in use, render `hard` as a strong prompt the user can dismiss. See
[If your update server is breached](/docs/security/breach).
:::

## Choosing a severity

| Situation | What to do |
|---|---|
| JS-only fix, same runtime version | publish an update; no store trip |
| A native dependency, TurboModule or native security fix | ship a store build with a higher build number, then raise `--min` for older builds |
| A new store build is out but the old one still works | `soft` |

`hard` stops people using the app, so be deliberate with it. The usual order is `soft` first, then
`hard` once the store build has had time to reach people.
