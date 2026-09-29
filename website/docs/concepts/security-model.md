---
sidebar_position: 2
title: Security model
description: Where trust lives, what each part of the system can do, and the one boundary worth understanding.
---

# Security model

The whole design follows from one decision: **the thing that distributes your updates is not
trusted to create them.**

## Who holds what

| | Holds the signing key | Can create an update | Can serve an update |
|---|---|---|---|
| Your CI / machine | **yes** | yes | no |
| The backend | no | **no** | yes |
| The device | no (public key only) | no | — verifies |

The CLI signs a manifest with an Ed25519 private key that lives in your CI or key store. The
backend receives that manifest already signed, stores it, and hands it out. The device verifies it
against a public key compiled into the app binary, in native code, before anything is written to
disk.

Integrity does not require the backend to be honest. A [breached server](/docs/security/breach)
cannot get around the signature, though it can still withhold updates, re-serve older signed
releases in some cases, and force a hard update prompt.

## The one boundary worth understanding

Integrity and confidentiality are not equally protected here, and the difference matters:

> **Integrity holds even if TLS is completely broken. The encryption does not keep bundles secret
> from anyone who can read a `/check` response.**

Integrity does not depend on the network. The verification key is in the binary, so a forged
certificate, hijacked DNS and a hostile server still cannot produce a manifest the device accepts.

Confidentiality is much weaker. The bundle bytes are AES-256-GCM ciphertext, but the content key
that opens them travels inside the manifest, which `/check` returns to any enrolled install for the
channel it asks about. The server operator has it, an active MITM who can read `/check` has it, and
devices store the decrypted files. So the encryption protects blobs from someone who can read the
blob store or a cache in front of it, and little else.

[TLS pinning](/docs/security/pinning-attestation) does not close the MITM case on its own: native
pins cover blob downloads, while `/check` goes through JavaScript `fetch`, which is pinned only if
you pass a pinned `fetch` as `transport`.

Stated plainly: **rely on signing for integrity.** Treat the encryption as protection for the blob
store, not for the bundle.

## Two controls that ship turned off

- **TLS certificate pinning** — enforced in native on blob downloads only. Set `ota_tls_pins`
  (Android) or `OTA_TLS_PINS` (iOS); a mismatch fails the download. Both platforms hash the full
  DER certificate, so one pin value covers both.
- **Device attestation** — the client attaches a Play Integrity or App Attest token at enrollment,
  and your `verifyEnrollToken` hook decides whether to trust it. dash-ota does not verify the token
  for you, and the token is not bound to a server challenge.

Neither is on until you configure it, and the core never depends on either.

## Going deeper

- [Threat model](/docs/security/threat-model) — the table of threat, control, and where it runs.
- [Controls explained](/docs/security/controls) — each control, property by property.
- [If your server is breached](/docs/security/breach) — what an attacker with root can and cannot do.
- [What dash-ota does not do](/docs/security/limitations) — the honest limits.
- [Keys, custody & rotation](/docs/security/key-management).
