---
sidebar_position: 12
title: Troubleshooting
---

# Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `enroll failed: 400` / no `devicePublicKeyB64` | native module not wired (stale build) or `getEnrollToken` returns nothing while `requireEnrollAuth` is on | Clean rebuild (regenerate codegen + native); supply `getEnrollToken`, or set `OTA_REQUIRE_ENROLL_AUTH=false` for local dev |
| `enroll failed: 401` | enroll token rejected | Implement `verifyEnrollToken` on the backend; pass a valid session token from `getEnrollToken` |
| **All bundled images vanish right after an update applies**, and the update reverts on the next launch | `react-native-dash-ota` **< 0.3.2**: every host read of the bundle path spent a crash-loop attempt, so the breaker fired on the first boot and deleted the slot directory while the bytecode was still mapped | Upgrade to **0.3.2 or later**. This is native code, so it needs a store release — an OTA cannot deliver it |
| `manifest signature did not verify` | the OTA was signed with a key the app doesn't embed | Embed the matching `ota_public_keys`; ensure the channel/key line up |
| "no update" when you expect one | `runtimeVersion`/`channel` mismatch, rollout bucket, or `bundleVersion` not greater | Confirm the published OTA's `runtimeVersion` equals the binary's; check `dash-ota list` |
| OTA never applies | applied on **cold start** only; debug build uses Metro | Use a **release** build; relaunch twice |
| Bundle won't load / crashes | Hermes bytecode mismatch | Compile the OTA with the **binary's** `hermesc`; the `runtimeVersion` must encode the Hermes ABI |
| Reverts every release | `markHealthy()` never called | Call it from your first usable screen, or set `autoMarkHealthyMs` |

## Every image goes blank after an update

The update applies, the JS runs, and every `require`d image renders as an empty box — then on the
next launch the update silently reverts.

This was a real bug, fixed in **0.4.0**. React Native reads the host's `getJSBundleFile()` /
`bundleURL()` five or six times per launch. Each read used to count a crash-loop boot attempt, so
the third read tripped the breaker on the *first* boot of every update, and the breaker deleted the
slot directory while the bytecode was still memory-mapped. JS kept running from the mapped file;
every image beside it was gone.

If you see this, you are on a build older than 0.4.0. It cannot be fixed by an OTA — the broken
code is native — so it needs a store release. Two things to check on the way:

- `adb logcat -s DashOta` should print `launch: applying pending … (attempt 1/2)` **once** per
  launch. Several such lines per launch is the old behaviour.
- A slot that is missing files it should have is refused at commit time in 0.4.0 and later, so this
  class of failure now shows up as a failed update with a clear message rather than a blank image.

## Reading logs

The provider logs through `config.logger` (defaults to `console`). In release builds, **`console.log`
is stripped** — only `console.error` and native logs surface. Watch logcat / Console for
`[dash-ota]` lines and native `DashOta` errors.

## When in doubt

- Verify the **installed** binary actually contains your latest JS + native (a clean reinstall
  beats `install -r`).
- Confirm the device's reported `runtimeVersion` matches the OTA's exactly.
- Check `dash-ota list` for the release's rollout %, paused state, and adoption.

## Seeing why an update did or did not apply

Release builds strip the JS `console.*` trail and a release APK is not debuggable, so from 0.3.2 the
**launch decision is logged natively**, one line per cold start. It never contains tokens, keys or
user data — only bundle ids and counters.

```bash
# Android (works on a release build, and on a real device)
adb logcat -s DashOta:W

# iOS simulator
xcrun simctl spawn booted log show --last 5m --predicate 'subsystem == "dash-ota"' --style compact
# iOS device: Console.app, filter the subsystem "dash-ota"
```

What the lines mean:

| Line | Meaning |
|---|---|
| `applying pending <id> on trial (attempt 1/2)` | the update is being applied for the first time |
| `<id> on trial, attempt n/2` | it has not been marked healthy yet; `n` counts real crashes |
| `... (previous launch refunded: reached JS then paused)` | the last launch ended because the user left, so it was not counted |
| `<id> (healthy)` | promoted to last-known-good; attempts are no longer counted |
| `crash loop: disabling <id>, reverting to <id>` | two real crashes; the bundle is blocklisted and reported |
| `state schema is not 2 — discarding it and starting clean` | upgrading from a pre-0.3.2 install |
| `no stored bundle — using the embedded one` | fresh install, or the state was just discarded |

Reading the state directly needs a debuggable build (`adb shell run-as`), root (an AOSP or
`google_apis` emulator image, `adb root`), or on the simulator the app container:
`xcrun simctl get_app_container booted <bundle-id> data`.
