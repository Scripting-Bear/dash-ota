---
sidebar_position: 10
title: Production hardening
---

# Production hardening

A checklist for running the distributor in production.

## Must-do

- ✅ **Keep `requireRequestSignature` and `requireEnrollAuth` on.** Disable only for local dev.
- ✅ **Implement `verifyEnrollToken`** against your real auth — don't ship the presence-only default.
- ✅ **Strong `adminToken`** from a secret; rotate it; restrict `/admin/*` at the network layer too.
- ✅ **HTTPS only** in front of the service.
- ✅ **Persistent, backed-up store** for releases + ciphertext (or a [custom store](/docs/backend/store)).

## Should-do

- **Redis** for nonce/token caches (so anti-replay survives multiple instances).
- **Object storage** for ciphertext; stream it through `/download` (still no S3 URL on the client).
- **Rate-limit** `/enroll` and `/check` per IP/install to blunt abuse.
- **Alert on auto-pause** and on elevated failure rates from `onConfirm`.
- **Tune anti-replay windows** (`timestampSkewMs`, `nonceTtlMs`) to your fleet's clock behaviour.

## Defense-in-depth (later, modular)

- **TLS pinning** on the client closes active-MITM confidentiality (the content key rides TLS).
- **Attestation** (Play Integrity / App Attest) raises the bar on cloned/modified apps.

Both are client plug-ins the backend doesn't need to know about.

## What you don't need to protect

The backend **never holds the signing key**, so even a full compromise can't forge an update. Its
blast radius is limited to: serving a validly-signed *older* bundle (rejected by the native
downgrade guard), denial of service, or leaking *adoption metadata*. Keep the signing key safe in
CI/KMS and that property holds.

→ [Key management](/docs/security/key-management) · [Threat model](/docs/security/threat-model)
