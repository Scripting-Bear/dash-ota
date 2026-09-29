# Interface: OtaUpdateState

Defined in: [types.ts:140](https://github.com/Scripting-Bear/dash-ota/blob/main/packages/rn/src/types.ts#L140)

What `useOtaUpdate()` returns.

## Properties

| Property | Type | Description | Defined in |
| ------ | ------ | ------ | ------ |
| <a id="property-applyupdate"></a> `applyUpdate` | (`restart?`) => `Promise`\<`boolean`\> | Escape hatch — [OtaUi.action](OtaUi.md#property-action) already does this at the right time. Apply a staged update on next launch (or restart now). Resolves **false** when nothing is staged yet — e.g. the download is still running — in which case no restart happens and the status is left alone, so a host UI can keep waiting instead of promising a restart that would discard the partial download. | [types.ts:177](https://github.com/Scripting-Bear/dash-ota/blob/main/packages/rn/src/types.ts#L177) |
| <a id="property-availableupdate"></a> `availableUpdate` | [`AvailableUpdate`](AvailableUpdate.md) \| `null` | - | [types.ts:151](https://github.com/Scripting-Bear/dash-ota/blob/main/packages/rn/src/types.ts#L151) |
| <a id="property-channel"></a> `channel` | `string` | the build flavour's channel (dev/uat/prod), embedded natively. | [types.ts:149](https://github.com/Scripting-Bear/dash-ota/blob/main/packages/rn/src/types.ts#L149) |
| <a id="property-checknow"></a> `checkNow` | () => `Promise`\<`void`\> | manually trigger a check (+ auto-download/stage unless `autoStage: false`). | [types.ts:157](https://github.com/Scripting-Bear/dash-ota/blob/main/packages/rn/src/types.ts#L157) |
| <a id="property-currentbundle"></a> `currentBundle` | [`BundleMeta`](BundleMeta.md) \| `null` | - | [types.ts:150](https://github.com/Scripting-Bear/dash-ota/blob/main/packages/rn/src/types.ts#L150) |
| <a id="property-downloadupdate"></a> `downloadUpdate` | () => `Promise`\<`boolean`\> | Escape hatch — [OtaUi.action](OtaUi.md#property-action) already does this at the right time. Download + verify + stage the update announced by the last check. Only needed with `autoStage: false`, where the check stops at `'update-available'` so the host can ask the user before spending bandwidth; a mandatory update downloads itself regardless. Resolves **false** when there is nothing to download (no announced update, or the download material has expired — re-run `checkNow()`). On success the status ends at `'apply-pending'`. | [types.ts:168](https://github.com/Scripting-Bear/dash-ota/blob/main/packages/rn/src/types.ts#L168) |
| <a id="property-error"></a> `error` | `string` \| `null` | - | [types.ts:155](https://github.com/Scripting-Bear/dash-ota/blob/main/packages/rn/src/types.ts#L155) |
| <a id="property-ismandatory"></a> `isMandatory` | `boolean` | - | [types.ts:152](https://github.com/Scripting-Bear/dash-ota/blob/main/packages/rn/src/types.ts#L152) |
| <a id="property-markhealthy"></a> `markHealthy` | () => `void` | mark the running bundle healthy (call once the app is genuinely usable). | [types.ts:179](https://github.com/Scripting-Bear/dash-ota/blob/main/packages/rn/src/types.ts#L179) |
| <a id="property-nativepolicy"></a> `nativePolicy` | [`NativeVersionPolicy`](NativeVersionPolicy.md) \| `null` | - | [types.ts:153](https://github.com/Scripting-Bear/dash-ota/blob/main/packages/rn/src/types.ts#L153) |
| <a id="property-progress"></a> `progress` | `number` | - | [types.ts:154](https://github.com/Scripting-Bear/dash-ota/blob/main/packages/rn/src/types.ts#L154) |
| <a id="property-rollback"></a> `rollback` | () => `Promise`\<`void`\> | force a rollback to last-known-good. | [types.ts:181](https://github.com/Scripting-Bear/dash-ota/blob/main/packages/rn/src/types.ts#L181) |
| <a id="property-status"></a> `status` | [`OtaStatus`](../type-aliases/OtaStatus.md) | - | [types.ts:147](https://github.com/Scripting-Bear/dash-ota/blob/main/packages/rn/src/types.ts#L147) |
| <a id="property-ui"></a> `ui` | [`OtaUi`](OtaUi.md) | The one thing a host UI should read: a derived, ready-to-render view model with a single [OtaUi.action](OtaUi.md#property-action). Prefer this over `status` — the raw statuses below are for diagnostics and for hosts that need to build a non-standard flow. | [types.ts:146](https://github.com/Scripting-Bear/dash-ota/blob/main/packages/rn/src/types.ts#L146) |
