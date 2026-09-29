---
sidebar_position: 4
title: Pinning & attestation
---

# Pinning & attestation

Two defense-in-depth controls. Both are off by default, so an existing app is unaffected until it
opts in.

## TLS certificate pinning (native blob downloads)

Native code pins the blob downloads (Android and iOS). It is **off by default**; enable it by
embedding one or more pins per build flavour:

- **Android:** the `ota_tls_pins` string resource.
- **iOS:** the `OTA_TLS_PINS` Info.plist key.

A pin is `base64( SHA-256( DER-encoded certificate ) )`: a hash of the whole certificate, not of its
public key (SPKI). Separate several pins with commas. The format is **identical across platforms**.
Empty ⇒ no pinning. A download succeeds when any certificate in the chain the platform validated
matches a pin. On Android that is the validated chain from 0.5.1 on; before 0.5.1 Android matched
against the chain the server presented, which a server holding any trusted certificate for your
host could extend with the pinned one. iOS has always used the evaluated chain.

```sh
# Compute a pin from the live server certificate:
openssl s_client -connect ota.example.com:443 </dev/null 2>/dev/null \
  | openssl x509 -outform der | openssl dgst -sha256 -binary | base64
```

:::warning[Pin before you enable]
A wrong pin **stops every OTA download**. Pin more than one certificate (e.g. current + next), or
pin your CA, and roll pins out ahead of a rotation. Verify on a device before shipping — this is
exactly why it ships off by default.
:::

### What native pinning does not cover

`/enroll`, `/check` and `/confirm` are JSON requests made with the app's JavaScript `fetch`, and
native pins do not apply to them. `/check` is where the content key and the download token arrive,
so native pinning alone does not keep either from an attacker who can forge a certificate for your
server. To pin those requests too, pass a `fetch` that enforces your pins as `transport`:

```ts
<DashOtaProvider config={{ /* ... */ transport: { fetch: pinnedFetch } }} />
```

`pinnedFetch` stands for a `fetch` implementation you provide that rejects certificates outside
your pin set. dash-ota does not ship one.

Integrity never depends on any of this: a forged certificate still cannot produce a manifest the
device accepts.

## Device/app integrity attestation

Provide an `IntegrityAttestor` and its token is attached at enrollment, where your backend's
`verifyEnrollToken` hook can verify it before registering the device key:

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

`getPlayIntegrityToken`, `verifySession` and `verifyPlayIntegrity` stand for your own code:
dash-ota neither produces nor verifies attestation tokens.

`getAttestationToken()` takes no argument, so the token is not bound to a challenge from your
server. A token captured from one enrollment can be replayed on another unless your verification
limits reuse, for example by rejecting tokens older than a few minutes.

When no attestor is configured (the default) the field is simply omitted.

## Hardware-key provenance

At enrollment the client reports `keyHardwareBacked`: whether its device key lives in secure
hardware (Android StrongBox/TEE, iOS Secure Enclave). The device reports this about itself, and the
backend cannot verify it, so treat it as a hint rather than proof. On iOS the key falls back to a
software Keychain key when the Secure Enclave is unavailable (always on the Simulator);
`OTA_REQUIRE_HARDWARE_KEY=true` makes key creation on a device **fail** instead of falling back.
