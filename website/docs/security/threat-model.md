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
| Reading blobs from the blob store or a cache in front of it | **AES-256-GCM** per blob; the content key is in the manifest, not beside the blobs | Native decrypt |
| Replayed update requests | Device-key **ECDSA P-256** signature over the request, a client nonce and a timestamp; a server-issued nonce ties `/confirm` to a real `/check` | Backend + native |
| Enrollment interception | A **device key** generated on the device; only the public half is sent, so there is no shared secret to intercept | Native keystore + backend `verifyEnrollToken` |
| A breached backend forging updates | The backend never holds the signing key | Architecture — see [If your server is breached](/docs/security/breach) |
| Replaying an older, validly-signed bundle | `bundleVersion` must be higher than the running bundle's. Not persisted: after a store update, `rollback()` or a crash-loop revert, an older signed release above the new current one installs again | Native |
| A bundle crossing environments | Signed `channel` compared to the binary's (client 0.5.1 and later), plus channel routing on the server | Native + backend filter |
| Swapping one asset inside a payload | The manifest lists a **SHA-256 per file**; native checks every one after decrypting | Native |
| A crash-looping bundle bricking the app | **Crash-loop breaker** → last-known-good (then embedded, 0.5.1 and later), disable and report | Native + provider |
| An OTA landing on an incompatible binary | Exact **`runtimeVersion`** match, a signed `minNativeBuild` (checked in native from 0.5.1), and stored bundles dropped when the native build changes | Backend + native |
| A forged TLS certificate | Certificate **pinning** on native blob downloads — **off until you set pins**. `/enroll`, `/check` and `/confirm` are pinned only if you pass a pinned `fetch` as `transport` | `ota_tls_pins` / `OTA_TLS_PINS`, native |
| A cloned or modified app | Play Integrity / App Attest token attached at enrollment — **off until you supply an attestor**; the token is not bound to a server challenge | `IntegrityAttestor` + your `verifyEnrollToken` |
| A hostile force-update redirect | The client uses **your** `config.storeUrl` and drops the server's (client 0.5.0 and later) | Provider, before the policy reaches your UI |

## The one control that matters most

Native Ed25519 verification against a key compiled into the binary. It holds **even if TLS is
completely broken**: an attacker with a forged certificate, full control of DNS, and the backend
itself still cannot produce a manifest the device will accept. Everything else in the table is
defence in depth around that one property.

## Out of scope

- **Confidentiality against an active MITM.** The content key and the download token come back
  from `/check`, which goes through the app's JavaScript `fetch`. Native pinning covers blob
  downloads only, so someone who can forge a certificate and read `/check` gets the key unless you
  also pin JavaScript requests through `transport`. Integrity is unaffected: it does not depend on
  TLS at all.
- **A rooted or jailbroken device.** Someone with full control of their own process can tamper
  with it. Native verification stops an unverified bundle from applying; it cannot stop tampering
  with a bundle that already passed. Attestation raises this bar, it does not remove it.
- **Revocation of an already-signed bundle.** `paused` and `rolledBack` are server-side state
  only, and the downgrade guard compares against the running bundle only. A breached backend can
  re-serve a release you pulled, or an older one after a store update or a revert.
  [More detail](/docs/security/breach).
- **Revocation of a signing key.** A binary trusts every key compiled into it until a store update
  replaces it. There is no remote revocation.
- **The force-update decision itself.** `severity` rides outside the manifest signature, so a
  breached server can send `hard` to every install, and an app that blocks on `hard` locks its users
  out. The destination is fixed (see the row above); the decision is not. Signing the policy is
  [on the roadmap](/docs/contributing/roadmap).
- **"Prevents all hacking"** is not a deliverable and dash-ota does not claim it.

→ [How each control works](/docs/security/controls) · [What it does not do](/docs/security/limitations)
