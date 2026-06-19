---
sidebar_position: 6
title: Force-update gate
description: Push users to the store when a native fix is required — the path OTA alone can't cover.
---

# Force-update gate

OTA updates JS, not native. When a fix **requires a new binary** (a native dependency, a
TurboModule change, a security patch in native), you need to push users to the store. dash-ota has
a built-in gate for exactly this.

## How it works

`/check` returns a **native-version policy** per channel:

```json
{
  "nativePolicy": {
    "minSupportedNativeVersion": 42,
    "severity": "hard",
    "storeUrl": "https://apps.apple.com/app/id..."
  }
}
```

The client surfaces it as `useOtaUpdate().nativePolicy`:

- **`severity: 'none'`** — the device meets the minimum; nothing to do.
- **`severity: 'soft'`** — the binary is below the minimum; show a **dismissible nudge**.
- **`severity: 'hard'`** — the binary is too old; show a **blocking "Update from Store"** screen
  using `storeUrl`.

## Set the policy

```bash
npx dash-ota native-policy --channel prod --min 42 --severity hard \
  --store-url "https://play.google.com/store/apps/details?id=..."
```

## Render the gate

```tsx
function ForceUpdateGate({ children }) {
  const { nativePolicy } = useOtaUpdate();
  if (nativePolicy?.severity === 'hard') {
    return <UpdateFromStoreScreen url={nativePolicy.storeUrl} />; // blocking
  }
  return (
    <>
      {nativePolicy?.severity === 'soft' && <UpdateNudge url={nativePolicy.storeUrl} />}
      {children}
    </>
  );
}
```

## When to use which

- **JS-fixable and same `runtimeVersion`?** Just OTA them — no store trip.
- **Native fix required / binary below minimum?** Set a `hard` (or `soft`) policy so old binaries
  are guided to the store while everyone else keeps getting OTAs.

→ [Force-update UI recipe](/docs/react-native/force-update-ui) · [Guide: force-update](/docs/guides/force-update)
