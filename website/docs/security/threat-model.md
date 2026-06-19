---
sidebar_position: 1
title: Threat model
---

# Threat model

What dash-ota defends against, the control, and where it's enforced. This is a concrete,
defensible model — not a claim of unhackability.

| Threat | Control (v1) | Enforced where |
|---|---|---|
| MITM / tampered bundle / injection | **Ed25519 signature** on the manifest, signed in CLI/CI, verified with a public key **embedded in the binary** | Sign: CLI · Verify: **native** (can't be bypassed from JS) |
| Sniffing the bundle on the wire | TLS **+** **AES-256-GCM** authenticated ciphertext; content key inside the signed manifest | Native decrypt |
| Replay of update requests | Device-key **ECDSA** signature + nonce + timestamp; server-issued nonce binds `/confirm` to a real `/check` | Backend + native |
| Enrollment interception | **Hardware device key** — only the public half is sent; no shared secret | Native keystore + backend `verifyEnrollToken` |
| Breached backend forging updates | Backend never holds the signing key | Architecture |
| Replayed old (validly-signed) bundle | Monotonic **`bundleVersion`** downgrade guard | Native |
| Cross-environment bundle | **Per-env signing keys** + channel routing | Native verify + backend filter |
| Asset swap inside a payload | Manifest lists **per-file SHA-256**; native verifies every file | Native |
| Crash-looping bundle bricking the app | **Crash-loop circuit breaker** → last-good → embedded; disable + report | Native + provider |
| Cross-runtime application | Exact **`runtimeVersion`** match required | Backend + native |
| Forged TLS cert *(active MITM confidentiality)* | Cert/public-key **pinning** — modular plug-in (deferred) | `TransportSecurity` |
| Cloned / modified app | Play Integrity / App Attest — modular plug-in (deferred) | `IntegrityAttestor` |

## The single most important control

**Native Ed25519 verification with an embedded public key.** It protects bundle **integrity even
if TLS is fully broken** — which is precisely why pinning can be deferred without compromising
integrity.

## Out of scope (honest)

- **Active-MITM confidentiality** of the payload waits for the pinning plug-in (the content key
  rides the TLS channel). Integrity does *not* wait — it holds regardless.
- **A rooted/jailbroken device** with full control can do many things; attestation raises that bar
  but is deferred and modular.
- **"All hacking prevention"** is not a finite deliverable. dash-ota implements a specific,
  defensible set of controls and is honest about the boundaries.

→ [Controls explained](/docs/security/controls) · [Limitations](/docs/security/limitations)
