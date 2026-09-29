# Interface: IntegrityAttestor

Defined in: [verifiers.ts:19](https://github.com/Scripting-Bear/dash-ota/blob/df5363f74f8243f8cfb8ecb1e117a3b2926aac5c/packages/rn/src/verifiers.ts#L19)

Device/app integrity attestation (Play Integrity / App Attest).

## Properties

| Property | Type | Description | Defined in |
| ------ | ------ | ------ | ------ |
| <a id="property-getattestationtoken"></a> `getAttestationToken` | () => `Promise`\<`string` \| `null`\> | Produce an attestation token to attach to OTA requests, or null when unavailable. v1 returns null (no attestation). | [verifiers.ts:24](https://github.com/Scripting-Bear/dash-ota/blob/df5363f74f8243f8cfb8ecb1e117a3b2926aac5c/packages/rn/src/verifiers.ts#L24) |
