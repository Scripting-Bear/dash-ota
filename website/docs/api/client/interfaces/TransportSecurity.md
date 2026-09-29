# Interface: TransportSecurity

Defined in: [verifiers.ts:10](https://github.com/Scripting-Bear/dash-ota/blob/main/packages/rn/src/verifiers.ts#L10)

Transport hardening (e.g. certificate / public-key pinning) applied to OTA requests.

## Properties

| Property | Type | Description | Defined in |
| ------ | ------ | ------ | ------ |
| <a id="property-fetch"></a> `fetch` | \{ (`input`, `init?`): `Promise`\<`Response`\>; (`input`, `init?`): `Promise`\<`Response`\>; \} | Wrap or replace `fetch` for OTA traffic. v1 returns the platform fetch unchanged; a pinning implementation returns a fetch that rejects forged certificates. | [verifiers.ts:15](https://github.com/Scripting-Bear/dash-ota/blob/main/packages/rn/src/verifiers.ts#L15) |
