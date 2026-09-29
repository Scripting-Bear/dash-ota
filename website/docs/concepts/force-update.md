---
sidebar_position: 6
title: Force-update gate
description: Push users to the store when a native fix is required — the path OTA alone can't cover.
---

# Force-update gate

OTA updates JS, not native. When a fix requires a new binary — a native dependency, a TurboModule
change, a security patch in native code — you have to send people to the store. The force-update
gate is how dash-ota tells an app that its binary is too old to keep going.

## How it works

Every `/check` returns a native-version policy for the channel, alongside the update itself:

```json
{
  "nativePolicy": {
    "minSupportedNativeVersion": 42,
    "severity": "hard",
    "storeUrl": "https://apps.apple.com/app/id..."
  }
}
```

The client surfaces it as `useOtaUpdate().nativePolicy`, with `severity` resolved server-side
against the running binary's build number:

| `severity` | Meaning | What to render |
|---|---|---|
| `none` | the binary meets the minimum | nothing |
| `soft` | below the minimum | a dismissible nudge |
| `hard` | too old to support | a blocking screen |

The gate and OTA coexist. A binary that meets the minimum keeps receiving JS updates as normal;
only the too-old ones are sent to the store.

## Set the policy

```bash
npx dash-ota native-policy --channel prod --min 42 --severity hard \
  --store-url "https://play.google.com/store/apps/details?id=com.you.app"
```

`--min` is the lowest native build number you still support. It is compared against the build
number compiled into the app (`ota_native_build` on Android, `CFBundleVersion` on iOS).

## Render the gate

dash-ota renders nothing itself — it hands you the policy and you decide what the user sees.

Give the provider your store listing. The client never passes the server's `storeUrl` through —
see the warning below — so without this the gate has no link:

```tsx
<DashOtaProvider
  config={{
    appVersion: '1.0.0',
    storage: AsyncStorage,
    storeUrl: Platform.select({
      ios: 'https://apps.apple.com/app/id000000000',
      default: 'market://details?id=com.you.app',
    }),
  }}
>
```

```tsx
function ForceUpdateGate({ children }: { children: React.ReactNode }) {
  const { nativePolicy } = useOtaUpdate();

  if (nativePolicy?.severity === 'hard') {
    return (
      <BlockingScreen
        title="Update required"
        body="A newer version is required to continue."
        cta="Update from Store"
        onPress={() => nativePolicy.storeUrl && Linking.openURL(nativePolicy.storeUrl)}
      />
    );
  }

  return (
    <>
      {nativePolicy?.severity === 'soft' && (
        <DismissibleBanner
          text="A new version is available."
          onPress={() => nativePolicy.storeUrl && Linking.openURL(nativePolicy.storeUrl)}
        />
      )}
      {children}
    </>
  );
}
```

:::warning[The policy is not signed — and only its URL is fixed]
`nativePolicy` is **not covered by the manifest signature**. It is a sibling of the signed
manifest in the `/check` response, not a field inside it, so everything in it is whatever the
server said.

The client closes the worst of that for you: **`nativePolicy.storeUrl` is always your
`config.storeUrl`, never the server's.** A value from the server is dropped and logged, even when
it looks like a real store link, because no scheme check can tell your listing from an attacker's
`https://` page.

What is **not** closed: `severity` and `minSupportedNativeVersion` are still the server's word.
Someone who controls the backend can set `severity: 'hard'` for every install and lock your users
out of the app. They cannot redirect them anywhere, but they can stop them. See
[If your server is breached](/docs/security/breach).
:::

## Choosing a severity

| Situation | What to do |
|---|---|
| JS-only fix, same `runtimeVersion` | publish an OTA, no store trip |
| Native dependency, TurboModule or native security fix | bump the native build, set `hard` for older builds |
| A new binary is out but the old one still works | `soft` |

A `hard` policy blocks people from using the app, so it is worth being deliberate about. `soft`
first, `hard` once the store build has had time to propagate, is the usual sequence.
