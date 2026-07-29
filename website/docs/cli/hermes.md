---
sidebar_position: 5
title: Hermes & HBC
---

# Hermes & HBC

The biggest OTA gotcha: **Hermes bytecode (HBC) is tied to the exact Hermes version in the
installed binary.** A plain JS bundle and the embedded HBC are not interchangeable, and an
HBC/version mismatch refuses to load or crashes.

## The rule

> Compile every OTA bundle to **HBC using the same `hermesc`** that shipped in the app binary, and
> make sure the `runtimeVersion` encodes the Hermes/native ABI.

Because dash-ota gates apply on an **exact `runtimeVersion` match** (enforced in native), a bundle
built for the wrong Hermes ABI simply won't be applied — it's rejected, not crashed-into.

## How to compile

`dash-ota bundle --hermes` compiles the bundle to HBC with the `hermesc` shipped in **your**
`react-native` install (so it matches the binary) and replaces the plain bundle in place. If
`--hermes` is requested but `hermesc` can't be found, it **fails loud** rather than silently
publishing a non-HBC bundle:

```bash
# 1. bundle + compile to HBC in one step
dash-ota bundle --project . --platform android --out ./out --hermes
# 2. publish the HBC payload
dash-ota publish --bundle-dir ./out --platform android --channel prod \
  --runtime-version auto --bundle-version 8
```

Without `--hermes` the output is a **plain JS bundle** (clearly labelled) — fine for a non-Hermes
(JSC) app, but for Hermes builds always pass `--hermes`. Recommended: ship **HBC** — it matches the
embedded behaviour and has faster TTI.

Under the hood this runs `hermesc -emit-binary -O -out <bundle> <bundle>` using
`node_modules/react-native/sdks/hermesc/<os>-bin/hermesc`.

## Source maps

OTA stack traces won't symbolicate against the store binary's maps. Generate the Hermes-composed
source map per OTA and upload it to your crash reporter (Crashlytics/Sentry), keyed by a
`debugId` + `{runtimeVersion, bundleVersion}`, so on-device OTA crashes resolve to original source.
