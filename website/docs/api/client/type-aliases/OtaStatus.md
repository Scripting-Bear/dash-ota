# Type Alias: OtaStatus

```ts
type OtaStatus = 
  | "idle"
  | "checking"
  | "up-to-date"
  | "update-available"
  | "downloading"
  | "apply-pending"
  | "error"
  | "disabled";
```

Defined in: [types.ts:11](https://github.com/Scripting-Bear/dash-ota/blob/main/packages/rn/src/types.ts#L11)

Lifecycle status surfaced by [useOtaUpdate](../functions/useOtaUpdate.md).
