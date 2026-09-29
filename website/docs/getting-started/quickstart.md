---
sidebar_position: 3
title: Ship your first update
description: Backend, keys, app wiring, and a signed update on a real device — start to finish.
---

# Ship your first update

Eight steps, start to finish: run a backend, make a signing key, wire the app, publish a change,
watch it land on a device, and pull it back. Around 20 minutes the first time.

Every step ends with what you should actually see. If your output doesn't match, stop there — the
next step will not work.

:::note[Use a release build]
Debug builds load JavaScript from Metro, so an OTA can never apply to one. Everything below assumes
a **release** build of your app. This trips up nearly everyone once.
:::

## 1. Run a backend

The backend is a plain Node service. Mount it into Express:

```ts title="server.ts"
import express from 'express';
import { dashOtaMiddleware, rawBodySaver } from '@dash-ota/backend';

const app = express();

// Keep the raw bytes — the request signature is computed over them.
app.use(express.json({ verify: rawBodySaver }));

app.use(
  dashOtaMiddleware({
    adminToken: process.env.OTA_ADMIN_TOKEN ?? 'dev-admin-token',
    verifyEnrollToken: (token) => Boolean(token), // replace with a real session check
  }),
);

app.listen(4455);
```

```bash
npm i @dash-ota/backend express
node server.ts
```

**You should see:** nothing from the CLI, and `curl localhost:4455/health` returning
`{"ok":true}`. If `/health` answers but `/ready` returns `503`, the service is up but its store
is not reachable.

Mount it at the **root** of the service. The OTA paths are absolute, and the request signature
covers the path the client sent, so a sub-path mount breaks verification.

→ [Backend installation](/docs/backend/installation) · [Deployment](/docs/backend/deployment)

## 2. Generate your signing key

This is the step that makes dash-ota different, so it's worth understanding rather than pasting.

You are about to create an **Ed25519 key pair**. The private half signs releases and lives only in
your CI or key store. The public half gets compiled into your app, and the app uses it to check
that an update really came from you. The backend never sees the private half — which is why a
breached backend [cannot forge an update](/docs/security/breach).

```bash
npx dash-ota keygen --key-id key_dev_1
```

**You should see:**

```
✓ wrote keypair to .keys/key_dev_1.*
  ✓ content key: .keys/key_dev_1.content.key — keep it, and reuse it for every release on this channel.
  ✓ private key encrypted at rest (AES-256-CBC).

  keyId:            key_dev_1
  publicKeyRawB64:  MclNZsT7zIV+qS2h23YgYW6D3yvbDtBKQDafBShqFGs=

  → Embed publicKeyRawB64 in the app (per channel) and KEEP THE PRIVATE KEY in CI secrets only.
```

Copy that `publicKeyRawB64` somewhere — step 4 needs it. Back up the `.content.key` file too: it
is not a secret, but every release on this channel must use the same one or you lose file
deduplication entirely.

Now tell the backend to trust this key:

```bash
npx dash-ota register-key --key-id key_dev_1 --key-file .keys/key_dev_1.public.json
```

**You should see:** `✓ registered key_dev_1 with http://localhost:4455`

If you get `✗ ... admin token`, set `OTA_ADMIN_TOKEN` to match what you gave the middleware. There
is no default, on purpose.

→ [Keys, custody & rotation](/docs/security/key-management)

## 3. Install the client

```bash
npm i react-native-dash-ota
cd ios && pod install && cd ..
```

Both platforms autolink. You do **not** need to register a package in `MainApplication`, add
anything to your `Podfile`, or write a ProGuard rule — the keep rule for the decompressor ships
with the library.

**You should see:** `pod install` listing `DashOta` among the installed pods.

## 4. Wire the native config

dash-ota reads five values from the binary, not from JavaScript. That is deliberate: the channel
and the public key have to be things an OTA cannot change about itself.

| Value | Android resource | iOS Info.plist key |
|---|---|---|
| Channel | `ota_channel` | `OTA_CHANNEL` |
| Backend URL | `ota_server_url` | `OTA_SERVER_URL` |
| Public key(s) | `ota_public_keys` | `OTA_PUBLIC_KEYS` |
| Runtime version | `ota_runtime_version` | `OTA_RUNTIME_VERSION` |
| Native build number | `ota_native_build` | `CFBundleVersion` |

For a first run, hardcode them. Android, in `android/app/build.gradle`:

```groovy
android {
  defaultConfig {
    resValue "string",  "ota_channel",         "dev"
    resValue "string",  "ota_server_url",      "http://10.0.2.2:4455"
    resValue "string",  "ota_public_keys",     "MclNZsT7zIV+qS2h23YgYW6D3yvbDtBKQDafBShqFGs="
    resValue "string",  "ota_runtime_version", "rt1"
    resValue "integer", "ota_native_build",    "1"
  }
}
```

`10.0.2.2` is how the Android emulator reaches your machine's localhost. On a physical device use
your machine's LAN IP. Plain `http://` to a non-local host is refused by the CLI unless you pass
`--allow-insecure`, and pinning (if you enable it later) requires HTTPS.

iOS, in `Info.plist`:

```xml
<key>OTA_CHANNEL</key><string>dev</string>
<key>OTA_SERVER_URL</key><string>http://localhost:4455</string>
<key>OTA_PUBLIC_KEYS</key><string>MclNZsT7zIV+qS2h23YgYW6D3yvbDtBKQDafBShqFGs=</string>
<key>OTA_RUNTIME_VERSION</key><string>rt1</string>
```

Then point React Native at the OTA bundle. This is the one native edit each platform needs.

```kotlin title="android/app/src/main/java/.../MainApplication.kt"
import com.dashota.DashOtaBundleLoader

override fun getJSBundleFile(): String? =
  DashOtaBundleLoader.getBundleFile(applicationContext)
```

```swift title="ios/AppDelegate.swift"
import DashOta

override func sourceURL(for bridge: RCTBridge) -> URL? { self.bundleURL() }

override func bundleURL() -> URL? {
#if DEBUG
  RCTBundleURLProvider.sharedSettings().jsBundleURL(forBundleRoot: "index")
#else
  DashOtaBundleLoader.bundleURL() ?? Bundle.main.url(forResource: "main", withExtension: "jsbundle")
#endif
}
```

→ [Android setup](/docs/react-native/android-setup) · [iOS setup](/docs/react-native/ios-setup) ·
[Per-environment config](/docs/react-native/environments)

## 5. Wrap your app

```tsx title="App.tsx"
import AsyncStorage from '@react-native-async-storage/async-storage';
import { DashOtaProvider } from 'react-native-dash-ota';

export default function Root() {
  return (
    <DashOtaProvider
      config={{
        appVersion: '1.0.0',
        storage: AsyncStorage,
        getEnrollToken: async () => myApi.getOtaEnrollToken(),
      }}
    >
      <App />
    </DashOtaProvider>
  );
}
```

`storage` holds the install id between launches — any object with `getItem` and `setItem` works,
so AsyncStorage, MMKV or a secure store are all fine. `getEnrollToken` is what your backend's
`verifyEnrollToken` checks, and it is how you stop strangers enrolling as your devices.

Build and install a **release** build, then launch it.

**You should see**, in `adb logcat -s DashOta:W` (or Console.app, subsystem `dash-ota`):

```
launch: no stored bundle — using the embedded one
```

That is the correct first-launch state: there is no OTA yet, so the app runs the bundle that
shipped inside it.

→ [Provider config](/docs/react-native/provider-config) · [`useOtaUpdate()`](/docs/react-native/use-ota-update)

## 6. Publish an update

Change something visible in your JavaScript first — a title, a colour — so you can tell whether it
landed.

```bash
npx dash-ota bundle --project . --platform android --out ./out --hermes
```

`--hermes` compiles the bundle to bytecode using the `hermesc` that shipped in *your*
`node_modules`. This matters: Hermes bytecode is tied to the exact Hermes version in the binary, so
a mismatch refuses to load. If `hermesc` is missing, the command fails loudly rather than quietly
publishing a plain JS bundle.

**You should see:** `✓ compiled Hermes bytecode (HBC): ...` then `✓ bundle written to ./out`.

```bash
npx dash-ota publish \
  --bundle-dir ./out --platform android --channel dev \
  --app-id com.your.app \
  --runtime-version auto --bundle-version 2 \
  --release-note "My first OTA"
```

`--runtime-version auto` fingerprints your native tree and uses the result, which is almost always
what you want. `--bundle-version` must be higher than what the device is running — the downgrade
guard rejects anything lower.

**You should see:**

```
runtimeVersion (auto): rt_9f2c1a...
  ✓ self-verified signature (sibling .public.json)

  bundleId:        bnd_rt_9f2c1a_2_m1p4x9
  runtimeVersion:  rt_9f2c1a...   bundleVersion: 2
  encryption:      aes-256-gcm
  uploading:       121 of 121 blobs (0 already present)   rollout: 100%
✓ published to http://localhost:4455: {"ok":true,"bundleId":"bnd_..."}
```

That `✓ self-verified signature` line is the CLI checking its own work: it verifies the manifest it
just signed against the public key your app embeds, and aborts before uploading if they don't
match. It is what stops you shipping an update every device would reject.

The second time you publish, `uploading:` will show far fewer blobs — unchanged files are already
stored and are not re-uploaded.

## 7. Watch it land

Relaunch the app. The provider checks, downloads and stages in the background, then arms the
bundle for the **next** cold start. So: launch once to fetch it, relaunch to run it.

**You should see** on the launch that applies it:

```
launch: applying pending bnd_rt_9f2c1a_2_m1p4x9 on trial (attempt 1/2)
```

Your change is now live. "On trial" means the bundle is being watched: if the app fails to reach
JavaScript twice in a row, the crash-loop breaker disables that bundle and reverts to the last one
that worked.

To leave the trial, your app must call `markHealthy()` once the first real screen is usable:

```tsx
const { markHealthy } = useOtaUpdate();
useEffect(() => { markHealthy(); }, []);
```

Until something calls it, every launch is still a trial launch.

Check the server's view:

```bash
npx dash-ota list
```

```
bnd_rt_9f2c1a_2_m1p4x9  [android/dev]  rt=rt_9f2c1a... v2  100%  adoption={"applied":1,"healthy":1}
```

→ [markHealthy in detail](/docs/react-native/mark-healthy) · [Crash-loop breaker](/docs/concepts/crash-loop)

## 8. Pull it back

```bash
npx dash-ota rollback --bundle-id bnd_rt_9f2c1a_2_m1p4x9
```

**You should see:** `✓ release rolled back (paused + flagged)`

Devices stop being offered it, and any device still downloading it gets a `410` on the remaining
blobs.

:::warning[Rollback is one-way]
`rollback` sets both `rolledBack` and `paused`. `pause --resume` clears the pause, but nothing
clears `rolledBack`, and there is no unpublish or delete. Recovering means publishing a new
release with a higher `bundleVersion`. Use `pause` if you only want to stop the bleeding.
:::

Devices that already applied the release keep running it — rollback stops distribution, it does
not reach back out to installed apps. Publish a fixed release to actually replace it.

## What happened

The CLI signed a manifest with your private key and sealed each file separately. The backend stored
the already-signed manifest and handed it out, never having had the ability to create one. On the
device, native code verified the Ed25519 signature against the key compiled into the binary,
decrypted each file, checked every hash against the manifest, and swapped the bundle atomically on
a cold start — with a breaker watching in case it doesn't boot.

## Next

- [Staged rollouts](/docs/guides/staged-rollout) — ship to 10% first
- [Environments](/docs/react-native/environments) — dev, uat and prod with separate keys
- [The dashboard](/docs/cli/dashboard) — do all of this from a local web console
- [The lifecycle in detail](/docs/concepts/lifecycle)
