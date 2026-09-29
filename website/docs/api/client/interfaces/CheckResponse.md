# Interface: CheckResponse

Defined in: [types.ts:70](https://github.com/Scripting-Bear/dash-ota/blob/df5363f74f8243f8cfb8ecb1e117a3b2926aac5c/packages/rn/src/types.ts#L70)

The `/check` response shape.

## Properties

| Property | Type | Defined in |
| ------ | ------ | ------ |
| <a id="property-downloadtoken"></a> `downloadToken?` | `string` | [types.ts:72](https://github.com/Scripting-Bear/dash-ota/blob/df5363f74f8243f8cfb8ecb1e117a3b2926aac5c/packages/rn/src/types.ts#L72) |
| <a id="property-nativepolicy"></a> `nativePolicy` | [`NativeVersionPolicy`](NativeVersionPolicy.md) | [types.ts:74](https://github.com/Scripting-Bear/dash-ota/blob/df5363f74f8243f8cfb8ecb1e117a3b2926aac5c/packages/rn/src/types.ts#L74) |
| <a id="property-servernonce"></a> `serverNonce` | `string` | [types.ts:73](https://github.com/Scripting-Bear/dash-ota/blob/df5363f74f8243f8cfb8ecb1e117a3b2926aac5c/packages/rn/src/types.ts#L73) |
| <a id="property-update"></a> `update` | [`SignedManifest`](SignedManifest.md) \| `null` | [types.ts:71](https://github.com/Scripting-Bear/dash-ota/blob/df5363f74f8243f8cfb8ecb1e117a3b2926aac5c/packages/rn/src/types.ts#L71) |
