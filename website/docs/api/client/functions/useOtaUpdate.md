# Function: useOtaUpdate()

```ts
function useOtaUpdate(): OtaUpdateState;
```

Defined in: [useOtaUpdate.ts:41](https://github.com/Scripting-Bear/dash-ota/blob/df5363f74f8243f8cfb8ecb1e117a3b2926aac5c/packages/rn/src/useOtaUpdate.ts#L41)

Read OTA state and drive actions. Must be used within [DashOtaProvider](DashOtaProvider.md).

## Returns

[`OtaUpdateState`](../interfaces/OtaUpdateState.md)

the [OtaUpdateState](../interfaces/OtaUpdateState.md): `ui` (the derived view model — read this), plus the raw
  `status`, `channel`, `currentBundle`, `availableUpdate`, `isMandatory`, `nativePolicy`,
  `progress`, `error`, and the actions `checkNow`, `downloadUpdate`, `applyUpdate`, `markHealthy`,
  `rollback` for non-standard flows.

## Example

**Standard flow**

The whole standard flow — announce, download, restart — is `ota.ui`:
```tsx
function UpdateRow() {
  const { ui, markHealthy } = useOtaUpdate();

  // Call once your first real screen is usable (drives the crash-loop breaker).
  useEffect(() => markHealthy(), []);

  if (!ui.visible) return null;
  return (
    <View>
      <Text>{ui.title}</Text>
      <Text>{ui.description}</Text>
      {ui.busy && <ActivityIndicator />}
      {ui.cta && <Button title={ui.cta} disabled={!ui.ctaEnabled} onPress={ui.action} />}
    </View>
  );
}
```
`ui.blocking` is true for a mandatory release — render the same thing as a non-dismissible modal
instead of a row, and the update downloads itself.
