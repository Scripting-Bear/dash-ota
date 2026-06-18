# react-native-dash-ota

Over-the-air (OTA) updates for React Native, done right: **Ed25519-signed** manifests **verified
in native**, **AES-256-GCM** payloads, **hardware device-key** request auth, `runtimeVersion`
gating, atomic apply on cold start, and **crash-loop rollback**. Part of
[dash-ota](https://github.com/Scripting-Bear/dash-ota).

- New Architecture (TurboModule, codegen `DashOtaSpec`, native module `DashOta`)
- Android (Kotlin + Google Tink) · iOS (Obj-C++ + Swift CryptoKit)
- Trust-critical work (verify / decrypt / hash / swap / rollback) runs in **native**, before and
  independent of JS — a compromised bundle can't bypass it.

> 📖 **Full integration guide:** https://github.com/Scripting-Bear/dash-ota/blob/main/docs/react-native.md

## Installation

```sh
npm install react-native-dash-ota
cd ios && pod install
```

Requires React Native **0.79+** with the **New Architecture** enabled, and Hermes.

## Usage

Per-flavour config (channel, server URL, embedded Ed25519 public key, `runtimeVersion`) comes
from the **native** side so it can't be tampered from JS — see the guide for the Android
`resValue` / iOS `Info.plist` setup and the `MainApplication`/`AppDelegate` bundle-loader hooks.

```tsx
import { DashOtaProvider, useOtaUpdate } from 'react-native-dash-ota';

export default function Root() {
  return (
    <DashOtaProvider
      config={{
        appVersion: '1.4.0',
        storage,                          // your AsyncStorage / secure-storage adapter
        getEnrollToken: () => auth.getSessionToken(),
        checkOnAppForeground: true,
      }}
    >
      <App />
    </DashOtaProvider>
  );
}

function UpdateControls() {
  const ota = useOtaUpdate();
  // { status, currentBundle, availableUpdate, isMandatory, nativePolicy, progress, error,
  //   checkNow, applyUpdate, markHealthy, rollback }
  useEffect(() => ota.markHealthy(), []); // call once the app is genuinely usable
  return <Button title="Check for updates" onPress={ota.checkNow} />;
}
```

See the [full guide](https://github.com/Scripting-Bear/dash-ota/blob/main/docs/react-native.md)
for all config options, the lifecycle, mandatory/force-update, and the crash-loop breaker.

## Contributing

- [Development workflow](CONTRIBUTING.md#development-workflow)
- [Sending a pull request](CONTRIBUTING.md#sending-a-pull-request)
- [Code of conduct](CODE_OF_CONDUCT.md)

## License

MIT
