---
sidebar_position: 3
title: Pinning & attestation (plug-ins)
---

# Pinning & attestation (plug-ins)

Two defense-in-depth controls are **deferred but modular** — the core never depends on them, so you
add them later without touching it.

## TransportSecurity (TLS pinning)

Closes **active-MITM confidentiality** (the AES content key rides the TLS channel). The client
exposes a `TransportSecurity` interface; inject a `fetch` that pins your server's certificate or
public key:

```ts
const transport: TransportSecurity = {
  fetch: pinnedFetch, // e.g. react-native-ssl-pinning / a TrustKit-backed fetch
};
<DashOtaProvider config={{ /* ... */ transport }} />
```

When omitted, dash-ota uses the platform `fetch` (still over HTTPS) — integrity is unaffected
either way, since that's guaranteed by native Ed25519 verification.

## IntegrityAttestor (Play Integrity / App Attest)

Raises the bar against **cloned or modified apps** calling your backend. The client exposes an
`IntegrityAttestor` interface; produce an attestation token your backend can verify before honoring
sensitive operations:

```ts
const attestor: IntegrityAttestor = {
  attest: async () => getPlayIntegrityToken(), // or App Attest on iOS
};
<DashOtaProvider config={{ /* ... */ attestor }} />
```

## Why they're deferred, not skipped

- **Pinning** needs a per-app certificate-rotation strategy (a real operational phase), so it's
  intentionally pluggable rather than baked in.
- **Attestation** requires the app to be on the Play Store / App Store to exercise the services
  end-to-end. Until then, the [hardware device-key enrollment](/docs/concepts/security-model) is the
  chosen non-attestation control.

Both are first-class interfaces, so adopting them is a config change, not a refactor.
