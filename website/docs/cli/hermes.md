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

The example's `scripts/publish-ota.mjs` does `bundle → hermesc → publish` in one step. Manually:

```bash
# 1. produce a JS bundle
dash-ota bundle --project . --platform android --out ./out
# 2. compile it to HBC with the binary's hermesc
node_modules/react-native/sdks/hermesc/osx-bin/hermesc \
  -emit-binary -O -out ./out/index.android.bundle ./out/index.android.bundle
# 3. publish the HBC payload
dash-ota publish --bundle-dir ./out --platform android --channel prod \
  --runtime-version auto --bundle-version 8
```

> Use the `hermesc` from **your** `react-native` install (it matches the binary). Recommended:
> ship **HBC**, not source — it matches the embedded behaviour and has faster TTI.

## Source maps

OTA stack traces won't symbolicate against the store binary's maps. Generate the Hermes-composed
source map per OTA and upload it to your crash reporter (Crashlytics/Sentry), keyed by a
`debugId` + `{runtimeVersion, bundleVersion}`, so on-device OTA crashes resolve to original source.
