---
sidebar_position: 10
title: Storage adapters
---

# Storage adapters

dash-ota needs a small key/value store to keep a stable install id: a random id created on the first
launch that identifies this installation to your backend. You pass the store as `config.storage`, and
anything with these two methods works:

```ts
interface OtaStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}
```

The provider writes two keys, `dash-ota.installId` and `dash-ota.enrolled` (exported as
`STORAGE_KEYS`).

## AsyncStorage

`@react-native-async-storage/async-storage` already has this shape, so pass it as it is:

```tsx
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { OtaConfig } from 'react-native-dash-ota';

const config: OtaConfig = {
  appVersion: '1.4.0',
  storage: AsyncStorage,
  getEnrollToken: async () => '<YOUR_SESSION_TOKEN>',
};
```

Pass the object itself rather than `AsyncStorage.getItem` on its own: a method separated from its
object can lose `this`.

## MMKV

This is for `react-native-mmkv` 4.x, which also needs `react-native-nitro-modules` installed. MMKV
reads and writes synchronously, so wrap the calls in `async` functions:

```ts
import { createMMKV } from 'react-native-mmkv';
import type { OtaStorage } from 'react-native-dash-ota';

const mmkv = createMMKV();

export const storage: OtaStorage = {
  getItem: async (key) => mmkv.getString(key) ?? null,
  setItem: async (key, value) => {
    mmkv.set(key, value);
  },
};
```

On `react-native-mmkv` 3.x, create the instance with `new MMKV()` (imported as `{ MMKV }`) instead of
`createMMKV()`; the rest is the same.

## Secure storage

If you want the install id in the Keychain or Keystore, wrap a library such as
`react-native-keychain` behind the same two methods.

:::tip[The install id is not a secret]
The device's own signing key is what authenticates it, and that key never leaves native code. The
install id only has to stay the same between launches. Storage that forgets it, such as an in-memory
object, makes every launch look like a new install: the device enrolls again each time, it lands in a
different group for staged rollouts on each launch, and your adoption numbers count it more than once.
:::
