# Interface: SignedManifest

Defined in: [types.ts:54](https://github.com/Scripting-Bear/dash-ota/blob/df5363f74f8243f8cfb8ecb1e117a3b2926aac5c/packages/rn/src/types.ts#L54)

A signed manifest as received from `/check` (opaque to JS; verified natively).

## Properties

| Property | Type | Defined in |
| ------ | ------ | ------ |
| <a id="property-keyid"></a> `keyId` | `string` | [types.ts:66](https://github.com/Scripting-Bear/dash-ota/blob/df5363f74f8243f8cfb8ecb1e117a3b2926aac5c/packages/rn/src/types.ts#L66) |
| <a id="property-manifest"></a> `manifest` | \{ \[`key`: `string`\]: `unknown`; `bundleId`: `string`; `bundleVersion`: `number`; `channel`: [`Channel`](../type-aliases/Channel.md); `mandatory`: `boolean`; `platform`: [`Platform`](../type-aliases/Platform.md); `releaseNotes?`: `string`; `runtimeVersion`: `string`; \} | [types.ts:55](https://github.com/Scripting-Bear/dash-ota/blob/df5363f74f8243f8cfb8ecb1e117a3b2926aac5c/packages/rn/src/types.ts#L55) |
| `manifest.bundleId` | `string` | [types.ts:56](https://github.com/Scripting-Bear/dash-ota/blob/df5363f74f8243f8cfb8ecb1e117a3b2926aac5c/packages/rn/src/types.ts#L56) |
| `manifest.bundleVersion` | `number` | [types.ts:58](https://github.com/Scripting-Bear/dash-ota/blob/df5363f74f8243f8cfb8ecb1e117a3b2926aac5c/packages/rn/src/types.ts#L58) |
| `manifest.channel` | [`Channel`](../type-aliases/Channel.md) | [types.ts:60](https://github.com/Scripting-Bear/dash-ota/blob/df5363f74f8243f8cfb8ecb1e117a3b2926aac5c/packages/rn/src/types.ts#L60) |
| `manifest.mandatory` | `boolean` | [types.ts:61](https://github.com/Scripting-Bear/dash-ota/blob/df5363f74f8243f8cfb8ecb1e117a3b2926aac5c/packages/rn/src/types.ts#L61) |
| `manifest.platform` | [`Platform`](../type-aliases/Platform.md) | [types.ts:59](https://github.com/Scripting-Bear/dash-ota/blob/df5363f74f8243f8cfb8ecb1e117a3b2926aac5c/packages/rn/src/types.ts#L59) |
| `manifest.releaseNotes?` | `string` | [types.ts:62](https://github.com/Scripting-Bear/dash-ota/blob/df5363f74f8243f8cfb8ecb1e117a3b2926aac5c/packages/rn/src/types.ts#L62) |
| `manifest.runtimeVersion` | `string` | [types.ts:57](https://github.com/Scripting-Bear/dash-ota/blob/df5363f74f8243f8cfb8ecb1e117a3b2926aac5c/packages/rn/src/types.ts#L57) |
| <a id="property-signatureb64"></a> `signatureB64` | `string` | [types.ts:65](https://github.com/Scripting-Bear/dash-ota/blob/df5363f74f8243f8cfb8ecb1e117a3b2926aac5c/packages/rn/src/types.ts#L65) |
