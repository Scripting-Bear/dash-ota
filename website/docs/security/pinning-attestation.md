---
sidebar_position: 3
title: Pinning & attestation
---

# Pinning & attestation

Two defense-in-depth controls, both now implemented and **customizable** — off by default so an
existing app is unaffected until it opts in.

## TLS certificate pinning (native download)

The trust-critical bundle download is pinned **natively** (Android + iOS), closing active-MITM on
the ciphertext transport. It's **off by default**; enable it by embedding one or more pins per build
flavour:

- **Android:** the `ota_tls_pins` string resource.
- **iOS:** the `OTA_TLS_PINS` Info.plist key.

A pin is `base64( SHA-256( DER-encoded server certificate ) )`, comma-separated for a set. The format
is **identical across platforms** (both hash the full DER cert). Empty ⇒ no pinning.

```sh
# Compute a pin from the live server certificate:
openssl s_client -connect ota.example.com:443 </dev/null 2>/dev/null \
  | openssl x509 -outform der | openssl dgst -sha256 -binary | base64
```

:::warning Pin before you enable
A wrong pin **bricks OTA updates**. Pin more than one certificate (e.g. current + next), or pin your
CA, and roll pins out ahead of a rotation. Verify on a device before shipping — this is exactly why
it ships off by default.
:::

The JS `TransportSecurity` hook still exists to pin the small JSON `/enroll` `/check` `/confirm`
calls (inject a pinned `fetch`); the native pin above covers the bundle bytes.

## Device/app integrity attestation

Wired end-to-end. Provide an `IntegrityAttestor` and its token is attached at enrollment, where your
backend's `verifyEnrollToken` hook can verify it before registering the device key:

```ts
const attestor: IntegrityAttestor = {
  getAttestationToken: async () => getPlayIntegrityToken(), // or App Attest on iOS
};
<DashOtaProvider config={{ /* ... */ attestor }} />
```

```ts
// backend
dashOtaMiddleware({
  verifyEnrollToken: (token, principal) => {
    // principal.attestationToken + principal.keyHardwareBacked are available here
    return verifySession(token) && verifyPlayIntegrity(principal.attestationToken);
  },
});
```

When no attestor is configured (the default) the field is simply omitted.

## Hardware-key provenance

The client reports whether its signing key is hardware-backed (Android StrongBox/TEE, iOS Secure
Enclave) as `keyHardwareBacked` at enrollment, so the backend can require genuine hardware. On iOS,
`OTA_REQUIRE_HARDWARE_KEY=true` makes key creation **fail closed** rather than silently falling back
to a software key.
