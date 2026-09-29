# Interface: OtaStorage

Defined in: [config.ts:13](https://github.com/Scripting-Bear/dash-ota/blob/main/packages/rn/src/config.ts#L13)

Minimal async key/value storage (e.g. AsyncStorage or secure storage).

## Properties

| Property | Type | Defined in |
| ------ | ------ | ------ |
| <a id="property-getitem"></a> `getItem` | (`key`) => `Promise`\<`string` \| `null`\> | [config.ts:14](https://github.com/Scripting-Bear/dash-ota/blob/main/packages/rn/src/config.ts#L14) |
| <a id="property-setitem"></a> `setItem` | (`key`, `value`) => `Promise`\<`void`\> | [config.ts:15](https://github.com/Scripting-Bear/dash-ota/blob/main/packages/rn/src/config.ts#L15) |
