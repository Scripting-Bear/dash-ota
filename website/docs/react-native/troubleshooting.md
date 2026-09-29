---
sidebar_position: 12
title: Troubleshooting
---

# Troubleshooting

Errors from the provider appear in `useOtaUpdate().error` and in the log as
`[dash-ota] check/stage failed: <reason>`. [Reading logs](#reading-logs) shows where to find them.

| Symptom | Likely cause | Fix |
|---|---|---|
| `enroll failed: 400` | The enroll request was missing a required field, usually the device public key. The native module is not built into the app (a stale build), or on iOS `OTA_REQUIRE_HARDWARE_KEY` is `true` on a device without a usable Secure Enclave. | Rebuild the app from clean so codegen and the native module are included. |
| `enroll failed: 401` | The backend refused the enroll token. Without a `verifyEnrollToken` hook, the backend only requires that a token is present (unless it runs with `OTA_REQUIRE_ENROLL_AUTH=false`), so `getEnrollToken` returned nothing. With the hook, the hook returned `false`. | Return the user's session token from `getEnrollToken`, and check what your `verifyEnrollToken` accepts. |
| `manifest signature did not verify` | The release was signed with a key the app does not contain. The CLI's `self-verified signature` line checks the release against the key pair in `.keys/`, not against the key in your app. | Put that key's `publicKeyRawB64` in `ota_public_keys` / `OTA_PUBLIC_KEYS` and ship a new build, or publish with the `--key-id` whose public key the app already has. |
| `manifest is for a different app` (Android), `manifest was built for a different app` (iOS) | `--app-id` differs from the app's `applicationId` or bundle identifier. | Publish with the exact id, including any `applicationIdSuffix` your flavour adds. |
| `bundle runtimeVersion does not match this binary` (Android), `runtimeVersion does not match this binary` (iOS) | `--runtime-version` at publish differs from the one in the app. | Publish with the app's `ota_runtime_version` / `OTA_RUNTIME_VERSION`. |
| `bundleVersion is not newer than current` (Android), `bundleVersion is not newer` (iOS) | The release's `--bundle-version` is not higher than the running bundle's. | Publish again with a higher `--bundle-version`. |
| `manifest is for channel <x>, not <y>` (Android), `manifest is for another channel` (iOS) | 0.5.1 and later: the release was published to a different `--channel` than the one compiled into the app. The server normally filters this out, so seeing it means the server offered a release from another channel. | Publish to the app's channel. If you didn't publish it there, treat it as a sign the server is misconfigured or compromised. |
| `manifest is for platform <x>` (Android), `manifest is for another platform` (iOS) | 0.5.1 and later: an Android release reached iOS or the other way round. | Publish each platform's bundle with its own `--platform`. |
| `bundle needs native build <n> or later` | 0.5.1 and later: the release was published with `--min-native-build` above this build's `ota_native_build` / `CFBundleVersion`. | Expected for older builds. The server normally doesn't offer it to them. |
| `bundleId <id> is not a safe file name`, `manifest entry <path> has a malformed sha256` | 0.5.1 and later: the signed manifest has an id or hash that can't be used as a file name. The CLI never produces one. | Publish without a hand-made `--bundle-id`, or check what built the manifest. |
| No update when you expect one | Something the server matches on differs: runtime version, channel, platform, app version range, `--min-native-build`, or rollout percentage. Or the release is not newer than what runs, or it is paused or rolled back. | Compare the release in `dash-ota list` with the values in the app. |
| The check fails with a network error on an Android release build | Release builds block plain `http://`. | Use HTTPS, or allow your local host in `network_security_config.xml` ([Android setup](/docs/react-native/android-setup#3-plain-http-to-a-backend-on-your-computer-optional)). |
| The update never applies | It is a debug build, which loads JavaScript from Metro. Or the app has not been cold-started since the update was staged. | Use a release build. The launch that finds an update only downloads it; it runs from the next cold start, or at once through "Restart now" / `applyUpdate(true)`. |
| The bundle is refused or crashes on load | The Hermes bytecode was compiled for a different Hermes version than the one in the app. | Run `dash-ota bundle --hermes` from the app project, so it uses that project's Hermes compiler, and change the runtime version whenever you upgrade React Native. |
| A release is disabled on some devices | Two counted launches without the trial ending: the bundle crashed, or the process died in the foreground before `markHealthy()` ran. | Find the crash in your crash reporter or in the logs below. Call `markHealthy()` from your first usable screen so a working bundle leaves its trial early. |
| All bundled images vanish right after an update applies, and the update reverts on the next launch | `react-native-dash-ota` older than 0.4.0: every read of the bundle path counted as a crash-loop attempt, so the breaker fired on the first launch and deleted the update's folder while it was running. | Upgrade to 0.4.0 or later. The fix is in native code, so it needs a store release; an OTA cannot deliver it. |
| npm warns about install scripts for `@mongodb-js/zstd` | npm 11 flags native modules that run install scripts. The CLI and backend use this one. | The install still works. If your npm version blocks the script, run `npm install-scripts approve @mongodb-js/zstd`. |

On iOS, 0.5.1 and later pass the real reason through, as in the table. Before 0.5.1, native errors
on iOS read "The operation couldn't be completed" whatever the cause.

## Images blank after an update

This was a bug before 0.4.0. The update applied and its JavaScript ran, but every `require`d image
rendered as an empty box, and on the next launch the update reverted.

React Native reads the bundle path five or six times per launch. Each read used to count a
crash-loop attempt, so the third read tripped the breaker on the first launch of every update, and
the breaker deleted the update's folder while the bytecode was still memory-mapped. JavaScript kept
running from the mapped file, and the images next to it were gone.

If you see this, the app's native build contains a client older than 0.4.0. It needs a store release.
Two ways to confirm:

- `adb logcat -s DashOta:W` prints `launch: applying pending … on trial (attempt 1/2)` once per
  launch. Several such lines in one launch is the old behaviour.
- In 0.4.0 and later, an update whose folder is missing a file is refused before it is staged, so
  this kind of failure shows up as a failed update with a message instead of blank images.

## Reading logs

Two sources write to the log:

- Native code logs one line per cold start saying which bundle it picked and why, under the Android
  tag `DashOta` and the iOS log subsystem `dash-ota`. These lines contain bundle ids and counters, and
  no tokens, keys or user data.
- The provider logs through `config.logger`. The default writes `[dash-ota] …` lines through
  `console`, which React Native keeps in release builds unless your app strips `console` calls. They
  appear under the Android tag `ReactNativeJS` and the iOS subsystem `com.facebook.react.log`, not
  under `DashOta`.

```bash
# Android, release build, emulator or device
adb logcat -s DashOta:W ReactNativeJS:I

# iOS simulator: the last five minutes
xcrun simctl spawn booted log show --last 5m --info --style compact \
  --predicate 'subsystem == "dash-ota" OR subsystem == "com.facebook.react.log"'
```

On an iOS device, open Console.app on your Mac, select the device, and filter on the same subsystems.

A first update, from a real run:

```
launch: no stored bundle — using the embedded one
[dash-ota] enrolled device key
[dash-ota] staged bnd_rt1_2_mumkmbz7 v2
launch: applying pending bnd_rt1_2_mumkmbz7 on trial (attempt 1/2)
[dash-ota] reporting applied bnd_rt1_2_mumkmbz7
launch: bnd_rt1_2_mumkmbz7 (healthy)
```

A bundle that crashed on two launches, and the launches after it:

```
launch: applying pending bnd_rt1_3_mumksul0 on trial (attempt 1/2)
launch: bnd_rt1_3_mumksul0 on trial, attempt 2/2
launch: crash loop: disabling bnd_rt1_3_mumksul0, reverting to bnd_rt1_2_mumkmbz7 on trial
[dash-ota] reporting crash-loop failure of bnd_rt1_3_mumksul0
[dash-ota] skipping disabled bundle bnd_rt1_3_mumksul0
```

What the native `launch:` lines mean:

| Line | Meaning |
|---|---|
| `launch: no stored bundle — using the embedded one` | No downloaded update: a fresh install, or stored updates were just discarded. |
| `launch: applying pending <id> on trial (attempt 1/2)` | A staged update runs for the first time. |
| `launch: <id> on trial, attempt <n>/2` | The update has not been marked healthy yet; `n` counts launches charged to it. |
| `… (previous launch refunded: reached JS then paused)` | The previous launch reached JavaScript and then went to the background, so it was not counted. |
| `… (user reload, not counted)` | This launch came from `applyUpdate(true)`, so it was not counted. |
| `launch: <id> (healthy)` | The bundle is last-known-good; launches are no longer counted. |
| `launch: crash loop: disabling <id>, reverting to <id> on trial` | Two counted launches: the bundle is disabled on this device, and the previous good bundle runs on trial. When there is none, the line ends `reverting to the embedded bundle`. |
| `launch: state schema is not 2 — discarding it and starting clean` | The app was updated from a build whose client was older than 0.4.0. |

On Android, `applyUpdate(true)` also logs `restart: relaunching for OTA apply` and
`restart: exiting process` under `DashOta`.

## Reading the stored state

The state file sits in the app's private storage. To read it you need a debuggable build
(`adb shell run-as <YOUR_APPLICATION_ID>`), root access (an AOSP or `google_apis` emulator image with
`adb root`), or on the iOS simulator the app container from
`xcrun simctl get_app_container booted <YOUR_BUNDLE_ID> data`.

## Still stuck

- Check that the installed app really contains your latest native and JavaScript changes. Uninstalling
  and installing again is more reliable than `adb install -r`.
- Compare the runtime version the device reports with the release's, character for character.
- Check `dash-ota list` for the release's rollout percentage, paused state and adoption counts.
