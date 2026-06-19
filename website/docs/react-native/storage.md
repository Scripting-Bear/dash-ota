---
sidebar_position: 10
title: Storage adapters
---

# Storage adapters

dash-ota only needs a tiny key/value store to persist a **stable install id**. You inject it via
`config.storage` — wrap whatever you already use.

```ts
interface OtaStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}
```

## AsyncStorage

```ts
import AsyncStorage from '@react-native-async-storage/async-storage';
const storage = { getItem: AsyncStorage.getItem, setItem: AsyncStorage.setItem };
```

## MMKV (fast, sync → wrap in Promises)

```ts
import { MMKV } from 'react-native-mmkv';
const mmkv = new MMKV();
const storage = {
  getItem: async (k: string) => mmkv.getString(k) ?? null,
  setItem: async (k: string, v: string) => mmkv.set(k, v),
};
```

## Secure storage

For a tamper-resistant install id, back it with Keychain/Keystore (e.g.
`react-native-keychain` or `react-native-fast-secure-storage`) behind the same interface.

:::tip
The install id is not a secret — the device's **hardware key** is the real credential. A stable id
just avoids re-enrolling on every cold start. In-memory storage works but re-enrolls each launch
(cheap, but a stable id is nicer).
:::
