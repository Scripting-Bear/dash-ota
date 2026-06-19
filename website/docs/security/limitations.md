---
sidebar_position: 5
title: Honest limitations
---

# Honest limitations

Security claims are only useful if they're precise. Here's what dash-ota does **not** do.

- **Active-MITM confidentiality** of the payload is **not** closed in the base config — the AES
  content key rides the TLS channel. It's closed by the (modular) [TLS pinning](/docs/security/pinning-attestation)
  plug-in. **Integrity is not affected** — it holds even if TLS is fully broken.
- **Attestation is deferred.** Until you add a `IntegrityAttestor`, dash-ota does not prove the app
  is genuine/unmodified. The hardware device key authenticates *the enrolled install*, not *app
  authenticity*.
- **A fully-controlled (rooted/jailbroken) device** can tamper with what runs in its own process.
  Native verification stops *unverified bundles* from applying, but on-device runtime tampering is a
  different threat that attestation (deferred) addresses.
- **The POC backend** is single-node with disk persistence — not HA. Production needs a real store
  (Postgres/Redis/object storage) and your gateway.
- **Encryption is defense-in-depth, not a magic shield.** Don't market AES-GCM as MITM-proof; rely on
  signing for integrity and pinning for active-MITM confidentiality.
- **OTA updates JS, not native.** Native fixes still require a store release — that's what the
  [force-update gate](/docs/concepts/force-update) is for.

## Why state these

Because the threat model is the product. A control you can reason about precisely is worth more than
a vague "bank-grade security" badge. dash-ota's strongest, unambiguous guarantee — **a breached
backend can't forge an update** — is exactly the one most OTA tools can't make.

→ [Threat model](/docs/security/threat-model)
