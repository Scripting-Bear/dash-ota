---
sidebar_position: 5
title: Hermes & HBC
---

# Hermes & HBC

Release builds of a React Native app run Hermes bytecode (HBC), not plain JavaScript. HBC is tied
to the Hermes version inside the app binary: bytecode from a different Hermes version won't load.

## The rule

Compile every update with the `hermesc` from the same `react-native` install the store build was
made from, and change your runtime version whenever you upgrade React Native.

The runtime version is what keeps a bundle away from a binary it can't run: devices only install
releases whose `runtimeVersion` equals their own. With `--runtime-version auto`, the React Native
and Hermes versions are part of the fingerprint, so an upgrade changes it for you. With a fixed
string such as `rt1`, it's on you to move to `rt2` in the same commit that upgrades React Native.
If an incompatible bundle does get installed, it fails to load, and the
[crash-loop breaker](/docs/concepts/crash-loop) takes the device back to the last bundle that
worked after two failed launches.

## How to compile

`dash-ota bundle --hermes` runs `react-native bundle`, then compiles the result with your
project's `hermesc` and replaces the plain bundle:

```bash
npx dash-ota bundle --project . --platform android --out ./ota-out/android --hermes
npx dash-ota publish --bundle-dir ./ota-out/android --app-id com.example.app \
  --platform android --channel prod --key-id key_prod_1 \
  --runtime-version rt1 --bundle-version 8
```

It finds `hermesc` in `node_modules/react-native/sdks/hermesc/<os>-bin/` (React Native 0.82 and
older) or in the `hermes-compiler` package (0.83 and later). If neither exists, it stops instead of
publishing plain JavaScript:

```
✗ hermesc was not found — cannot produce an HBC bundle. Looked for:
```

followed by both paths it tried.

Without `--hermes` the output is a plain JavaScript bundle. That is right for an app that runs on
JSC, and wrong for one on Hermes, which is the default.

Keep `--out` the same for every release. The compiler runs on a relative path, so the same source
always produces the same bytes, and the server skips files it already has.

## Source maps

Crashes in an OTA bundle won't symbolicate against the store build's source maps. The CLI doesn't
produce source maps, so generate one yourself when you build the bundle (`react-native bundle
--sourcemap-output`, then compose it with the Hermes map as your crash reporter documents) and
upload it keyed by `runtimeVersion` and `bundleVersion`.
