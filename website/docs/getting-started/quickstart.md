---
sidebar_position: 3
title: Ship your first update
description: Backend, keys, app wiring, and a signed update on a real device, start to finish.
---

# Ship your first update

Eight steps: run a backend, make a signing key, wire the app, publish a change, watch it land on
a device, and pull it back. Plan on 30 to 45 minutes the first time, most of it waiting for
release builds.

Every step ends with what you should see. If your output doesn't match, stop there; the next step
won't work either.

**You need:** Node 20.19 or later, an existing React Native app on 0.79 or later, and an Android
emulator or iOS simulator. If any of that is new to you, read
[What an OTA update is](/docs/getting-started/what-is-an-ota-update) and
[Before you start](/docs/getting-started/prerequisites) first.

:::note[Use a release build]
Debug builds load JavaScript from Metro, so an OTA update never applies to them. Everything below
uses a **release** build of your app.
:::

You will work in two folders side by side: your app (called `my-app` here) and a small server
folder, `ota-server`. Keep a terminal open in each.

## 1. Run a backend

The backend stores releases and hands them to devices. It never holds your signing key.

In a new folder next to your app:

```bash
mkdir ota-server && cd ota-server
npm init -y
npm i @dash-ota/backend express
```

Create `server.mjs`:

```js title="ota-server/server.mjs"
import express from 'express';
import { dashOtaMiddleware, rawBodySaver } from '@dash-ota/backend';

const adminToken = process.env.OTA_ADMIN_TOKEN;
if (!adminToken) throw new Error('Set OTA_ADMIN_TOKEN before starting the server.');

const app = express();
// Keep the raw bytes: request signatures are computed over them. Release manifests can be large.
app.use(express.json({ limit: '10mb', verify: rawBodySaver }));
app.use(
  dashOtaMiddleware({
    adminToken,
    storageDir: './ota-data/storage',
    dataDir: './ota-data/db',
    verifyEnrollToken: (token) => Boolean(token), // replace with a real session check
  }),
);
app.listen(4455, () => console.log('dash-ota backend listening on http://localhost:4455'));
```

Pick an admin token (any long random string) and start the server:

```bash
export OTA_ADMIN_TOKEN=<YOUR_ADMIN_TOKEN>
node server.mjs
```

**You should see:** `dash-ota backend listening on http://localhost:4455`, and in another terminal
`curl localhost:4455/health` prints `{"ok":true}`.

Two things in that file matter later:

- `storageDir` and `dataDir` put releases in `ota-server/ota-data`. Keep that folder; it is your
  release history.
- `verifyEnrollToken: (token) => Boolean(token)` lets any device register. That is fine on your
  machine. Before real users see it, make it check a real session. See
  [Backend installation](/docs/backend/installation).

Mount the middleware at the root of the service, as here. Request signatures cover the full path,
so mounting it under a sub-path breaks them.

## 2. Install the CLI and make your signing key

The CLI builds and signs releases. It is a dev dependency of your app, so run everything from here
on in `my-app`:

```bash
cd my-app
npm i -D @dash-ota/cli
echo ".keys/" >> .gitignore
```

`npx dash-ota …` runs that local copy, so everyone on the project uses the version in your
lockfile.

Now make an **Ed25519 key pair**. The private half signs every release and never leaves your
machine or CI. The public half gets compiled into your app, and the app uses it to check that an
update really came from you. The backend never sees the private half, which is why a breached
backend [cannot forge an update](/docs/security/breach).

```bash
npx dash-ota keygen --key-id key_dev_1
```

It asks for a passphrase to encrypt the private key. Type one and keep it: you need it every time
you publish. (Leaving it empty stores the key unencrypted; the CLI warns you if you do.)

**You should see:**

```
✓ wrote keypair to .keys/key_dev_1.*
  ✓ content key: .keys/key_dev_1.content.key — keep it, and reuse it for every release on this channel.
  ✓ private key encrypted at rest (AES-256-CBC).

  keyId:            key_dev_1
  publicKeyRawB64:  <44-character base64 string>

  → Embed publicKeyRawB64 in the app (per channel) and KEEP THE PRIVATE KEY in CI secrets only.
```

Copy the `publicKeyRawB64` value; step 4 needs it. The files are in `my-app/.keys/`. Back up
`key_dev_1.private.pem` and `key_dev_1.content.key` somewhere safe: losing the private key means
you can't publish to apps that trust it.

Give this terminal the two values the CLI will ask for, then tell the backend to trust your key:

```bash
export OTA_ADMIN_TOKEN=<YOUR_ADMIN_TOKEN>        # the same value the server uses
export OTA_KEY_PASSPHRASE=<YOUR_KEY_PASSPHRASE>  # the passphrase you just typed
npx dash-ota register-key --key-id key_dev_1 --key-file .keys/key_dev_1.public.json
```

**You should see:** `✓ registered key_dev_1 with http://localhost:4455`

If it says the admin token is missing or wrong, `OTA_ADMIN_TOKEN` in this terminal doesn't match
the server's. There is no default token.

→ [Keys, custody & rotation](/docs/security/key-management)

## 3. Install the client

```bash
npm i react-native-dash-ota @react-native-async-storage/async-storage
cd ios && pod install && cd ..
```

Both platforms autolink, and the ProGuard/R8 rule the library needs ships inside it. The client
needs somewhere to keep a small install id; AsyncStorage is used here, but any object with
`getItem` and `setItem` works ([Storage](/docs/react-native/storage)).

**You should see:** `pod install` listing `Installing DashOta`.

## 4. Wire the native side

dash-ota reads its settings from the binary, not from JavaScript, so an update can never change
which server it trusts or which key it accepts.

| Setting | Android resource | iOS Info.plist key |
|---|---|---|
| Channel | `ota_channel` | `OTA_CHANNEL` |
| Backend URL | `ota_server_url` | `OTA_SERVER_URL` |
| Public key(s) | `ota_public_keys` | `OTA_PUBLIC_KEYS` |
| Runtime version | `ota_runtime_version` | `OTA_RUNTIME_VERSION` |
| Native build number | `ota_native_build` (integer) | `CFBundleVersion` (your build number) |

The **runtime version** says which native build an update is for. An update only installs on a
binary with exactly the same value. Use a plain string like `rt1` and change it whenever you
change native code. ([Runtime versions](/docs/concepts/versioning-targeting))

### Android

In `android/app/build.gradle`, inside `defaultConfig`:

```groovy title="android/app/build.gradle"
android {
  defaultConfig {
    // ...your existing settings...
    resValue "string",  "ota_channel",         "dev"
    resValue "string",  "ota_server_url",      "http://10.0.2.2:4455"
    resValue "string",  "ota_public_keys",     "<YOUR_PUBLIC_KEY>"
    resValue "string",  "ota_runtime_version", "rt1"
    resValue "integer", "ota_native_build",    "1"
  }
}
```

`<YOUR_PUBLIC_KEY>` is the `publicKeyRawB64` from step 2. `10.0.2.2` is how the Android emulator
reaches your computer; on a physical device, use your computer's LAN IP.

Release builds refuse plain `http://` by default, so allow it for your local backend only. Create
`android/app/src/main/res/xml/network_security_config.xml`:

```xml title="android/app/src/main/res/xml/network_security_config.xml"
<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
  <!-- Local development only: lets a release build reach a plain-HTTP backend on your machine. -->
  <domain-config cleartextTrafficPermitted="true">
    <domain includeSubdomains="false">10.0.2.2</domain>
    <domain includeSubdomains="false">localhost</domain>
  </domain-config>
</network-security-config>
```

and point the `<application>` tag in `android/app/src/main/AndroidManifest.xml` at it:

```xml
<application
  ...
  android:networkSecurityConfig="@xml/network_security_config">
```

Remove both once your backend is on HTTPS.

Then tell React Native to load the OTA bundle. Open `MainApplication.kt`. What you change depends
on which template your app came from.

If it has `override val reactHost: ReactHost by lazy { getDefaultReactHost(...) }` (React Native
0.82 and later), add one argument:

```kotlin title="android/app/src/main/java/.../MainApplication.kt"
import com.dashota.DashOtaBundleLoader

  override val reactHost: ReactHost by lazy {
    getDefaultReactHost(
      context = applicationContext,
      packageList = PackageList(this).packages,
      jsBundleFilePath = DashOtaBundleLoader.getBundleFile(applicationContext),
    )
  }
```

If it has `override val reactNativeHost: ReactNativeHost = object : DefaultReactNativeHost(this) {`
(React Native 0.79 to 0.81), add the override **inside that object**:

```kotlin title="android/app/src/main/java/.../MainApplication.kt"
import com.dashota.DashOtaBundleLoader

  override val reactNativeHost: ReactNativeHost =
    object : DefaultReactNativeHost(this) {
      // ...the existing overrides stay as they are...

      override fun getJSBundleFile(): String? =
        DashOtaBundleLoader.getBundleFile(applicationContext)
    }
```

With no update installed, the loader returns `null` and React Native loads the bundle inside the
APK as usual.

### iOS

In `ios/<YourApp>/Info.plist`, inside the top-level `<dict>`:

```xml title="ios/<YourApp>/Info.plist"
<key>OTA_CHANNEL</key>
<string>dev</string>
<key>OTA_SERVER_URL</key>
<string>http://localhost:4455</string>
<key>OTA_PUBLIC_KEYS</key>
<string><YOUR_PUBLIC_KEY></string>
<key>OTA_RUNTIME_VERSION</key>
<string>rt1</string>
```

The simulator reaches your computer as `localhost`, and the React Native template already allows
local plain HTTP. The native build number is your `CFBundleVersion`; keep it a whole number.

In `ios/<YourApp>/AppDelegate.swift`, add `import DashOta` at the top, and change the release
branch of `bundleURL()` in the `ReactNativeDelegate` class:

```swift title="ios/<YourApp>/AppDelegate.swift"
import DashOta

class ReactNativeDelegate: RCTDefaultReactNativeFactoryDelegate {
  override func sourceURL(for bridge: RCTBridge) -> URL? {
    self.bundleURL()
  }

  override func bundleURL() -> URL? {
#if DEBUG
    RCTBundleURLProvider.sharedSettings().jsBundleURL(forBundleRoot: "index")
#else
    DashOtaBundleLoader.bundleURL() ?? Bundle.main.url(forResource: "main", withExtension: "jsbundle")
#endif
  }
}
```

Keep the `?? Bundle.main.url(...)` part. The loader returns `nil` until an update is installed,
and without the fallback a fresh install has no JavaScript to run.

→ [Android setup](/docs/react-native/android-setup) · [iOS setup](/docs/react-native/ios-setup) ·
[Per-environment config](/docs/react-native/environments)

## 5. Wrap your app

```tsx title="App.tsx"
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect } from 'react';
import { Text, View } from 'react-native';
import { DashOtaProvider, useOtaUpdate } from 'react-native-dash-ota';

function Home() {
  const { markHealthy } = useOtaUpdate();

  // Marks this bundle as working. Call it once your first real screen is usable.
  useEffect(() => {
    markHealthy();
  }, [markHealthy]);

  return (
    <View>
      <Text>Hello from the embedded build</Text>
    </View>
  );
}

export default function App() {
  return (
    <DashOtaProvider
      config={{
        appVersion: '1.0.0',
        storage: AsyncStorage,
        getEnrollToken: async () => '<YOUR_ENROLL_TOKEN>',
      }}
    >
      <Home />
    </DashOtaProvider>
  );
}
```

In a real app, `Home` is your existing root component and `getEnrollToken` returns your user's
session token, which the backend's `verifyEnrollToken` checks. For this walkthrough any non-empty
string works.

Build and install a release build, then launch it:

```bash
npx react-native run-android --mode release
# or
npx react-native run-ios --mode Release
```

**You should see**, in `adb logcat -s DashOta:W ReactNativeJS:I` (iOS: Console.app, subsystem
`dash-ota`, plus the JavaScript log):

```
launch: no stored bundle — using the embedded one
[dash-ota] enrolled device key
```

That is the right first-launch state: there is no update yet, so the app runs the JavaScript that
shipped inside it, and the device has registered with your backend.

→ [Provider config](/docs/react-native/provider-config) · [`useOtaUpdate()`](/docs/react-native/use-ota-update)

## 6. Publish an update

Change something you can see, for example the text in `Home`. Then build the bundle:

```bash
npx dash-ota bundle --project . --platform android --out ./ota-out/android --hermes
```

`--hermes` compiles the JavaScript to Hermes bytecode with the `hermesc` from your own
`node_modules`, so it matches the Hermes inside your app. Use the same `--out` folder every time:
the output path ends up in the bytecode, and a stable path lets unchanged files be skipped on the
next upload.

**You should see** it end with:

```
✓ compiled Hermes bytecode (HBC): /…/my-app/ota-out/android/index.android.bundle

✓ bundle written to ./ota-out/android
```

Now sign and upload it:

```bash
npx dash-ota publish \
  --bundle-dir ./ota-out/android --platform android --channel dev \
  --app-id <YOUR_APPLICATION_ID> \
  --runtime-version rt1 --bundle-version 2 \
  --release-note "My first OTA"
```

- `<YOUR_APPLICATION_ID>` is your Android `applicationId` (in `android/app/build.gradle`) or iOS
  bundle identifier. The device refuses a release built for a different id.
- `--runtime-version rt1` must equal what the app embeds (step 4).
- `--bundle-version` must be higher than what the device runs. The embedded bundle counts as 0.

**You should see** (your bundle id and sizes will differ):

```
  ✓ self-verified signature (.keys/key_dev_1.public.json)

  bundleId:        bnd_rt1_2_mumketyh
  runtimeVersion:  rt1   bundleVersion: 2
  files:           1 (1 distinct blobs)   1.25 MB → 481.4 KB
  encryption:      aes-256-gcm
  uploading:       1 of 1 blobs (0 already present)   rollout: 100%
  uploaded 1/1
✓ published to http://localhost:4455: {"ok":true,"bundleId":"bnd_rt1_2_mumketyh","rolloutPercentage":100,"already":false}
```

The `self-verified signature` line checks the release against the key in `.keys/`, not against
what your app embeds. If you put a different public key in step 4, the CLI can't tell, and every
device refuses the update with `manifest signature did not verify`.

For iOS, run the same two commands with `--platform ios`, `--out ./ota-out/ios` and
`--bundle-dir ./ota-out/ios`.

## 7. Watch it land

Close the app completely (swipe it away), then open it again. It checks, downloads and verifies
the update in the background while you use it:

```
[dash-ota] staged bnd_rt1_2_mumketyh v2
```

The update applies on the **next** cold start, so close the app and open it once more:

```
launch: applying pending bnd_rt1_2_mumketyh on trial (attempt 1/2)
```

Your change is now on screen.

"On trial" means dash-ota is watching this bundle. Each cold start that crashes counts as a failed
attempt; after two, the bundle is switched off on that device and the app goes back to the last
bundle that worked. A launch where the app starts normally and the user then leaves it doesn't
count against it. Calling `markHealthy()`, as `Home` does, ends the trial.
([Crash-loop breaker](/docs/concepts/crash-loop))

Check the server's view:

```bash
npx dash-ota list
```

```
bnd_rt1_2_mumketyh  [android/dev]  rt=rt1 v2  100%  adoption={"applied":1,"healthy":1,"failed":0,"rolled_back":0}
```

`healthy` can take one more launch to show up: each check lets the device send one report, and
`applied` goes first.

→ [markHealthy in detail](/docs/react-native/mark-healthy)

## 8. Pull it back

```bash
npx dash-ota rollback --bundle-id bnd_rt1_2_mumketyh
```

**You should see:** `✓ release rolled back (paused + flagged)`, and `list` now shows
`ROLLED_BACK` for it.

New devices stop being offered it, and a download already in progress fails. Devices that already
installed it keep running it: rollback stops distribution, it doesn't reach into installed apps.
To replace a bad release, publish a fixed one with a higher `--bundle-version`.

:::warning[Rollback is one-way]
`rollback` both pauses the release and flags it as rolled back. `pause --resume` lifts the pause,
but nothing clears the flag, and there is no delete. If you only want to stop a rollout for now,
use `npx dash-ota pause --bundle-id <id>` instead.
:::

## What happened

The CLI signed a manifest listing every file with your private key and encrypted each file. The
backend stored the signed manifest and served it; it never had the key needed to make one. On
the device, native code checked the signature against the public key compiled into the app,
checked that the release was for this app, runtime version, channel and platform, verified every
file's hash, and swapped bundles on a cold start, with the crash-loop breaker ready to undo it.

## Next

- [Staged rollouts](/docs/guides/staged-rollout): ship to 10% first
- [Environments](/docs/react-native/environments): dev, uat and prod with separate keys
- [The dashboard](/docs/cli/dashboard): publish and manage rollouts from a local web page
- [The lifecycle in detail](/docs/concepts/lifecycle)
