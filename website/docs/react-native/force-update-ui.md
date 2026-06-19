---
sidebar_position: 9
title: Force-update UI
---

# Force-update UI

When a native fix is required, the [force-update gate](/docs/concepts/force-update) tells too-old
binaries to update from the store. Render it from `nativePolicy`:

```tsx
function ForceUpdateGate({ children }: { children: React.ReactNode }) {
  const { nativePolicy } = useOtaUpdate();

  if (nativePolicy?.severity === 'hard') {
    return (
      <BlockingScreen
        title="Update required"
        body="A newer version is required to continue."
        cta="Update from Store"
        onPress={() => Linking.openURL(nativePolicy.storeUrl!)}
      />
    );
  }

  return (
    <>
      {nativePolicy?.severity === 'soft' && (
        <DismissibleBanner
          text="A new version is available."
          onPress={() => Linking.openURL(nativePolicy.storeUrl!)}
        />
      )}
      {children}
    </>
  );
}
```

`severity` is `'none'` (meets minimum), `'soft'` (dismissible nudge), or `'hard'` (blocking). Set
the policy with [`dash-ota native-policy`](/docs/cli/commands#native-policy).
