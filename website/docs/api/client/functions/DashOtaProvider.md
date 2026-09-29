# Function: DashOtaProvider()

```ts
function DashOtaProvider(props): ReactElement;
```

Defined in: [DashOtaProvider.tsx:77](https://github.com/Scripting-Bear/dash-ota/blob/main/packages/rn/src/DashOtaProvider.tsx#L77)

Wrap your app root to enable OTA. On launch it reads the current bundle, enrolls the hardware
device key (once), and — by default — checks → downloads → natively verifies/stages → schedules
an apply on next cold start. Everything fails closed: any error leaves the last-known-good /
embedded bundle running. State + actions are exposed via [useOtaUpdate](useOtaUpdate.md).

## Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `props` | [`DashOtaProviderProps`](../interfaces/DashOtaProviderProps.md) | `config` ([OtaConfig](../interfaces/OtaConfig.md)) + your app's `children`. |

## Returns

`ReactElement`

## Example

```tsx
import { DashOtaProvider } from 'react-native-dash-ota';

export default function Root() {
  return (
    <DashOtaProvider
      config={{
        appVersion: '1.4.0',
        storage,                                     // AsyncStorage / MMKV / secure-storage adapter
        getEnrollToken: () => auth.getSessionToken(), // ties the device key to a real user
        checkOnAppForeground: true,
      }}
    >
      <App />
    </DashOtaProvider>
  );
}
```
