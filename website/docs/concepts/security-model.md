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

Nothing in that chain requires the backend to be honest. That is the point, and it is what
[a breached server](/docs/security/breach) cannot get around.

## The one boundary worth understanding

Integrity and confidentiality are not equally protected here, and the difference matters:

> **Integrity holds even if TLS is completely broken. Confidentiality against an active MITM does
> not, until you turn pinning on.**

Integrity does not depend on the network at all. The verification key is in the binary, so a forged
certificate, hijacked DNS and a hostile server still cannot produce a manifest the device accepts.

Confidentiality is weaker. The bundle bytes are AES-256-GCM ciphertext, but the content key that
opens them travels inside the manifest, over the same TLS channel. Someone who can forge a
certificate and read `/check` can read the key. So encryption here buys you protection against
passive sniffing and against anyone reading the blob store — not against an attacker who is
actively sitting in the connection.

Closing that last gap is what [TLS pinning](/docs/security/pinning-attestation) is for. It ships,
and it is off until you set pins.

Stated plainly: **rely on signing for integrity, and on pinning for confidentiality against an
active MITM.** Do not oversell the encryption as MITM-proof — it isn't, and the docs say so on
purpose.

## Two controls that ship turned off

- **TLS certificate pinning** — enforced in native on the blob download. Set `ota_tls_pins`
  (Android) or `OTA_TLS_PINS` (iOS); a mismatch throws. Both platforms hash the full DER
  certificate, so one pin value covers both.
- **Device attestation** — the client attaches a Play Integrity or App Attest token at enrollment,
  and your `verifyEnrollToken` hook decides whether to trust it. dash-ota does not verify the token
  for you.

Neither is on until you configure it, and the core never depends on either.

## Going deeper

- [Threat model](/docs/security/threat-model) — the table of threat, control, and where it runs.
- [Controls explained](/docs/security/controls) — all thirteen controls, property by property.
- [If your server is breached](/docs/security/breach) — what an attacker with root can and cannot do.
- [What dash-ota does not do](/docs/security/limitations) — the honest limits.
- [Keys, custody & rotation](/docs/security/key-management).
