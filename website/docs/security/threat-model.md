---
sidebar_position: 1
title: Threat model
---

# Threat model

What dash-ota defends against, which control does it, and where that control runs. Two of the
rows are off by default; they say so.

| Threat | Control | Enforced where |
|---|---|---|
| MITM, tampered bundle, code injection | **Ed25519 signature** over the manifest, signed in the CLI, verified with a public key **compiled into the binary** | Sign: CLI · Verify: **native**, not reachable from JS |
| Sniffing the bundle on the wire | TLS plus **AES-256-GCM** authenticated ciphertext; the content key travels inside the signed manifest | Native decrypt |
| Replayed update requests | Device-key **ECDSA P-256** signature, nonce and timestamp; a server-issued nonce binds `/confirm` to a real `/check` | Backend + native |
| Enrollment interception | **Hardware device key** — only the public half ever leaves the device, so there is no shared secret to intercept | Native keystore + backend `verifyEnrollToken` |
| A breached backend forging updates | The backend never holds the signing key | Architecture — see [If your server is breached](/docs/security/breach) |
| Replaying an old, validly-signed bundle | Monotonic **`bundleVersion`** downgrade guard | Native |
| A bundle crossing environments | Per-channel signing keys plus channel routing | Native verify + backend filter |
| Swapping one asset inside a payload | The manifest lists a **SHA-256 per file**; native checks every one after decrypting | Native |
| A crash-looping bundle bricking the app | **Crash-loop breaker** → last-known-good → embedded, then disable and report | Native + provider |
| An OTA landing on an incompatible binary | Exact **`runtimeVersion`** match, plus a native build-number gate on the stored slot | Backend + native |
| A forged TLS certificate | Certificate **pinning** on the blob download — **off until you set pins** | `ota_tls_pins` / `OTA_TLS_PINS`, native |
| A cloned or modified app | Play Integrity / App Attest token attached at enrollment — **off until you supply an attestor** | `IntegrityAttestor` + your `verifyEnrollToken` |
| A hostile force-update redirect | The client uses **your** `config.storeUrl` and drops the server's | Provider, before the policy reaches your UI |

## The one control that matters most

Native Ed25519 verification against a key compiled into the binary. It holds **even if TLS is
completely broken**: an attacker with a forged certificate, full control of DNS, and the backend
itself still cannot produce a manifest the device will accept. Everything else in the table is
defence in depth around that one property.

## Out of scope

- **Confidentiality against an active MITM**, unless you turn pinning on. The AES content key
  rides inside the manifest over the same TLS channel, so someone who can forge a certificate and
  read `/check` can read the key. Integrity is unaffected — it does not depend on TLS at all.
- **A rooted or jailbroken device.** Someone with full control of their own process can tamper
  with it. Native verification stops an unverified bundle from applying; it cannot stop tampering
  with a bundle that already passed. Attestation raises this bar, it does not remove it.
- **Revocation of an already-signed bundle.** `paused` and `rolledBack` are server-side state
  only, so a breached backend can re-serve a higher-versioned release you pulled. The downgrade
  guard blocks older versions, not withdrawn newer ones. [More detail](/docs/security/breach).
- **The force-update decision itself.** `severity` and `minSupportedNativeVersion` ride outside
  the manifest signature, so a breached server can hold every install behind a blocking gate. The
  destination is fixed (see the row above); the decision is not. Signing the policy is
  [on the roadmap](/docs/contributing/roadmap).
- **"Prevents all hacking"** is not a deliverable and dash-ota does not claim it.

→ [How each control works](/docs/security/controls) · [What it does not do](/docs/security/limitations)
