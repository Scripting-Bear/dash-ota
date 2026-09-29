# Type Alias: Channel

```ts
type Channel = "dev" | "uat" | "prod";
```

Defined in: [types.ts:7](https://github.com/Scripting-Bear/dash-ota/blob/main/packages/rn/src/types.ts#L7)

Public TypeScript types for react-native-dash-ota. These describe the runtime shapes the
native module returns and the protocol payloads (a RN-safe subset that does NOT import any
Node APIs — the native side owns the trust-critical crypto).
