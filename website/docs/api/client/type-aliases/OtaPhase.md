# Type Alias: OtaPhase

```ts
type OtaPhase = "none" | "available" | "working" | "ready" | "error";
```

Defined in: [types.ts:95](https://github.com/Scripting-Bear/dash-ota/blob/main/packages/rn/src/types.ts#L95)

What an update UI actually needs to know — the four states a user can be in, derived from
[OtaStatus](OtaStatus.md) so hosts never map raw lifecycle statuses themselves.

- `none` — nothing to show (idle, up-to-date, disabled).
- `available` — an update exists and is waiting for the user to start the download.
- `working` — checking or downloading; show progress and no action.
- `ready` — verified and staged; the app must restart to run it.
- `error` — the last attempt failed; the action retries.
