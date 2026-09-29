# Variable: STORAGE\_KEYS

```ts
const STORAGE_KEYS: {
  enrolled: "dash-ota.enrolled";
  installId: "dash-ota.installId";
};
```

Defined in: [config.ts:91](https://github.com/Scripting-Bear/dash-ota/blob/main/packages/rn/src/config.ts#L91)

Storage keys used internally.

## Type Declaration

### enrolled

```ts
readonly enrolled: "dash-ota.enrolled" = 'dash-ota.enrolled';
```

Marker proving this install already enrolled its current device key, so we don't re-POST
`/enroll` (and re-attest, burning attestation quota) on every cold start. Value =
`sha256(installId + ':' + devicePublicKeyB64)`, so a key rotation or reinstall re-enrolls.

### installId

```ts
readonly installId: "dash-ota.installId" = 'dash-ota.installId';
```
