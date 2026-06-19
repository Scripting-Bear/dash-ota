---
sidebar_position: 4
title: Security at a glance
description: The controls dash-ota uses and what each one actually buys you.
---

# Security at a glance

A quick map of dash-ota's controls. For the full treatment, see the
[Security model](/docs/concepts/security-model) and [Threat model](/docs/security/threat-model).

| Threat | Control | Enforced where |
|---|---|---|
| MITM / tampered bundle / injection | **Ed25519 signature** on the manifest, public key embedded in the binary | Sign: CLI · Verify: **native** |
| Sniffing the payload | TLS **+** **AES-256-GCM** authenticated ciphertext | Native decrypt |
| Replay of requests | Device-key **ECDSA** signature + nonce + timestamp; server-issued nonce binds `/confirm` to `/check` | Backend + native |
| Enrollment interception | **Hardware device key** — only the public half is sent; no shared secret | Native keystore + backend |
| Breached backend forging updates | Backend never holds the signing key | Architecture |
| Replayed old bundle | Monotonic `bundleVersion` downgrade guard | Native |
| Crash-looping bundle | Circuit breaker → last-known-good → embedded; disable + report | Native + provider |
| Forged TLS cert *(later)* | Cert/public-key **pinning** — modular plug-in | `TransportSecurity` |
| Cloned/modified app *(later)* | Play Integrity / App Attest — modular plug-in | `IntegrityAttestor` |

## Honest notes

- **Integrity vs confidentiality.** Ed25519 gives **integrity even if TLS is fully broken** —
  that's why pinning can be deferred. AES-256-GCM protects the payload against *passive* sniffing
  and at-rest exposure, but against an *active* MITM the content key rides the same TLS channel,
  so confidentiality against active MITM is only closed by the (modular) pinning plug-in.
- **Pinning and attestation are deferred but modular** — the core never depends on them, so you
  can add them later without touching it.
- **"All hacking prevention" is not a finite deliverable.** dash-ota implements a concrete,
  defensible threat model; the single most important control is **native Ed25519 verification
  with an embedded key**.

→ [Read the full security model](/docs/concepts/security-model)
