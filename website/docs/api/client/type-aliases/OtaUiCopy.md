# Type Alias: OtaUiCopy

```ts
type OtaUiCopy = Record<Exclude<OtaPhase, "none">, OtaUiPhaseCopy>;
```

Defined in: [types.ts:106](https://github.com/Scripting-Bear/dash-ota/blob/main/packages/rn/src/types.ts#L106)

Overridable copy per actionable phase — pass a partial via `OtaConfig.uiCopy`.
