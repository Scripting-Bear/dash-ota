# Interface: OtaUi

Defined in: [types.ts:113](https://github.com/Scripting-Bear/dash-ota/blob/df5363f74f8243f8cfb8ecb1e117a3b2926aac5c/packages/rn/src/types.ts#L113)

A ready-to-render view model for the update UI. Everything a row/banner/modal needs, so the host
renders it and calls [OtaUi.action](#property-action) — no status mapping, no in-flight guard, no branching
between download and restart.

## Properties

| Property | Type | Description | Defined in |
| ------ | ------ | ------ | ------ |
| <a id="property-action"></a> `action` | () => `Promise`\<`void`\> | performs the correct next step for the current phase (download → restart → retry). | [types.ts:129](https://github.com/Scripting-Bear/dash-ota/blob/df5363f74f8243f8cfb8ecb1e117a3b2926aac5c/packages/rn/src/types.ts#L129) |
| <a id="property-blocking"></a> `blocking` | `boolean` | the update is mandatory: the host should not let the user dismiss or defer this UI. | [types.ts:127](https://github.com/Scripting-Bear/dash-ota/blob/df5363f74f8243f8cfb8ecb1e117a3b2926aac5c/packages/rn/src/types.ts#L127) |
| <a id="property-busy"></a> `busy` | `boolean` | an operation is in flight — show a spinner and keep the action inert. | [types.ts:123](https://github.com/Scripting-Bear/dash-ota/blob/df5363f74f8243f8cfb8ecb1e117a3b2926aac5c/packages/rn/src/types.ts#L123) |
| <a id="property-cta"></a> `cta` | `string` \| `null` | - | [types.ts:119](https://github.com/Scripting-Bear/dash-ota/blob/df5363f74f8243f8cfb8ecb1e117a3b2926aac5c/packages/rn/src/types.ts#L119) |
| <a id="property-ctaenabled"></a> `ctaEnabled` | `boolean` | false while an action is running, or when the phase has no action. | [types.ts:121](https://github.com/Scripting-Bear/dash-ota/blob/df5363f74f8243f8cfb8ecb1e117a3b2926aac5c/packages/rn/src/types.ts#L121) |
| <a id="property-description"></a> `description` | `string` | - | [types.ts:118](https://github.com/Scripting-Bear/dash-ota/blob/df5363f74f8243f8cfb8ecb1e117a3b2926aac5c/packages/rn/src/types.ts#L118) |
| <a id="property-phase"></a> `phase` | [`OtaPhase`](../type-aliases/OtaPhase.md) | - | [types.ts:114](https://github.com/Scripting-Bear/dash-ota/blob/df5363f74f8243f8cfb8ecb1e117a3b2926aac5c/packages/rn/src/types.ts#L114) |
| <a id="property-progress"></a> `progress` | `number` \| `null` | 0..1 when known, `null` when the download reports no granular progress (show indeterminate). | [types.ts:125](https://github.com/Scripting-Bear/dash-ota/blob/df5363f74f8243f8cfb8ecb1e117a3b2926aac5c/packages/rn/src/types.ts#L125) |
| <a id="property-title"></a> `title` | `string` | - | [types.ts:117](https://github.com/Scripting-Bear/dash-ota/blob/df5363f74f8243f8cfb8ecb1e117a3b2926aac5c/packages/rn/src/types.ts#L117) |
| <a id="property-visible"></a> `visible` | `boolean` | convenience for `phase !== 'none'`. | [types.ts:116](https://github.com/Scripting-Bear/dash-ota/blob/df5363f74f8243f8cfb8ecb1e117a3b2926aac5c/packages/rn/src/types.ts#L116) |
