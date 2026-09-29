---
sidebar_position: 10
title: Production hardening
---

# Production hardening

A checklist for running the distributor in production.

## Must-do

- **Keep `requireRequestSignature` and `requireEnrollAuth` on.** Disable only for local dev.
- **Implement `verifyEnrollToken`** against your real auth. The default only checks that a token is
  present, so any non-empty string enrolls.
- **Strong `adminToken`** from a secret; rotate it; restrict `/admin/*` at the network layer too.
- **HTTPS only** in front of the service.
- **Persistent, backed-up store** for releases and blobs (or a [custom store](/docs/backend/providers)).
  With the disk store, set `storageDir` and `dataDir` explicitly; the defaults are relative to the
  working directory the server starts in.

## Should-do

- **Redis** for nonce/token caches (so anti-replay survives multiple instances).
- **Object storage** for blobs; they are still streamed through
  `/ota/v2/releases/{bundleId}/blobs/{sha256}`, so the client never sees a storage URL.
- **Rate limits:** `/enroll` and `/check` are limited per install out of the box; add per-IP limits
  at your reverse proxy.
- **Alert on auto-pause** and on elevated failure rates from `onConfirm`.
- **Tune anti-replay windows** (`timestampSkewMs`, `nonceTtlMs`) to your fleet's clock behaviour,
  keeping `nonceTtlMs` at least twice `timestampSkewMs` (the defaults are 10 and 5 minutes).
  Shorter, and a request replayed after its nonce expires but while its timestamp is still in the
  window is accepted.
- **Give `getEnrollToken` a short-lived, enrollment-only token** rather than your main session
  token; the OTA server sees it.

## Defense-in-depth (client-side, opt-in)

- **TLS pinning:** native pins cover blob downloads only. `/check`, which carries the content key
  and the download token, is pinned only if the app passes a pinned `fetch` as `transport`.
- **Attestation** (Play Integrity / App Attest) gives `verifyEnrollToken` a token to check; it is not
  bound to a server challenge.

Both are client settings the backend doesn't need to know about.

## What a full compromise can still do

The backend **never holds the signing key**, so even a full compromise can't forge or modify an
update. It can still:

- withhold updates from any install;
- re-serve a validly-signed release you rolled back, or an older one to a device whose running
  bundle is below it (for example after a store update with an unchanged `runtimeVersion`);
- send `severity: 'hard'` to every install, which locks users out if the app blocks on it;
- read every bundle, since the manifests carry the content key;
- collect the enrollment tokens clients send, and falsify release state and adoption numbers.

Keep the signing key in CI or a KMS and that first property holds; the rest is covered in
[If your server is breached](/docs/security/breach).

→ [Key management](/docs/security/key-management) · [Threat model](/docs/security/threat-model)
