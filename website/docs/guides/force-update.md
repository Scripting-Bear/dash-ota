---
sidebar_position: 5
title: Force-update to the store
---

# Force-update to the store

When a fix needs a **new binary** (native change), OTA can't help — you must send users to the
store. dash-ota's force-update gate handles this.

## 1. Set the policy
```bash
dash-ota native-policy --channel prod --min 42 --severity hard \
  --store-url "https://play.google.com/store/apps/details?id=com.you.app"
```
- `--min` — the minimum supported native build number.
- `--severity hard` — blocking; `soft` — a dismissible nudge.

## 2. Render the gate
The client receives the policy as `useOtaUpdate().nativePolicy`. Wrap your app:
```tsx
function Gate({ children }) {
  const { nativePolicy } = useOtaUpdate();
  if (nativePolicy?.severity === 'hard') return <UpdateFromStore url={nativePolicy.storeUrl} />;
  return <>{nativePolicy?.severity === 'soft' && <Nudge url={nativePolicy.storeUrl} />}{children}</>;
}
```
Full example: [Force-update UI](/docs/react-native/force-update-ui).

## When to use it
| Situation | Action |
|---|---|
| JS-only fix, same `runtimeVersion` | OTA — no store trip |
| Native dep / TurboModule / native security fix | bump native build, set a `hard` policy for older builds |
| Want to nudge but not block | `soft` policy |

The gate and OTA coexist: in-range binaries keep getting OTAs; only too-old ones are gated to the store.
