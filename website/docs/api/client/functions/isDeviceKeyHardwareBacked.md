# Function: isDeviceKeyHardwareBacked()

```ts
function isDeviceKeyHardwareBacked(): boolean;
```

Defined in: [deviceKey.ts:24](https://github.com/Scripting-Bear/dash-ota/blob/main/packages/rn/src/deviceKey.ts#L24)

Whether the device's OTA signing key lives in secure hardware — Android StrongBox/TEE or the iOS
Secure Enclave — rather than a software Keychain/Keystore fallback.

Worth surfacing in a diagnostics screen: simulators and emulators have no secure element and
always report `false`, so this is the only way to confirm on real hardware that enrollment used a
non-exportable key. Returns `false` if the native side cannot answer.

## Returns

`boolean`

true when the key is hardware-backed.

## Example

```ts
import { isDeviceKeyHardwareBacked } from 'react-native-dash-ota';
console.log('hardware-backed key:', isDeviceKeyHardwareBacked());
```
