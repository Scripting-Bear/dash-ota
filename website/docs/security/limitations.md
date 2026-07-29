---
sidebar_position: 5
title: Honest limitations
---

# Honest limitations

Security claims are only useful if they're precise. Here's what dash-ota does **not** do.

- **Active-MITM confidentiality** of the payload is **not** closed unless you enable
  [TLS pinning](/docs/security/pinning-attestation) — the AES content key rides the TLS channel.
  Native cert pinning is built in but **off by default**. **Integrity is not affected** — it holds
  even if TLS is fully broken.
- **Attestation is off until you provide an `IntegrityAttestor`.** The interface is wired end-to-end
  (token reaches `verifyEnrollToken`), but with no attestor dash-ota does not prove the app is
  genuine/unmodified — the hardware device key authenticates *the enrolled install*, not *app
  authenticity*.
- **Enrollment must be gated by you.** `installId` is non-secret and enroll overwrites the stored
  device key, so a production backend **must** wire `verifyEnrollToken` to bind enrollment to an
  authenticated session. Without it, anyone knowing an `installId` can impersonate that device.
- **No signed revocation.** `paused`/`rolledBack` are server-side-only state. A *breached* backend
  can't forge a bundle, but it can re-serve a previously-signed, higher-versioned bundle that was
  later rolled back; the downgrade guard only blocks *older* versions, and the crash-loop breaker is
  the client-side backstop. A signed minimum-version channel is planned.
- **A fully-controlled (rooted/jailbroken) device** can tamper with its own process. Native
  verification stops *unverified bundles* from applying; on-device runtime tampering is what
  attestation addresses.
- **iOS download memory bound is partial.** The download is rejected if its size ≠ the signed
  `ciphertextSize`, but iOS currently buffers the body before that check (a streaming bounded
  download is in progress); Android streams with a hard cap.
- **Encryption is defense-in-depth, not a magic shield.** Rely on signing for integrity and pinning
  for active-MITM confidentiality.
- **OTA updates JS, not native.** Native fixes still require a store release — that's what the
  [force-update gate](/docs/concepts/force-update) is for.

## Why state these

Because the threat model is the product. A control you can reason about precisely is worth more than
a vague "bank-grade security" badge. dash-ota's strongest, unambiguous guarantee — **a breached
backend can't forge an update** — is exactly the one most OTA tools can't make.

→ [Threat model](/docs/security/threat-model)
