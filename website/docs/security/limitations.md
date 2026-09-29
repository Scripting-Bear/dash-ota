---
sidebar_position: 6
title: Honest limitations
---

# Honest limitations

Security claims are only useful if they're precise. Here's what dash-ota does **not** do.

- **No confidentiality against an active MITM out of the box.** The content key and the download
  token (valid for 30 minutes by default) arrive on `/check`, which goes through JavaScript `fetch`.
  Native [TLS pinning](/docs/security/pinning-attestation) is built in, **off by default**, and
  covers blob downloads only; `/enroll`, `/check` and `/confirm` are pinned only if you pass a
  pinned `fetch` as `transport`. **Integrity is not affected** — it holds even if TLS is fully broken.
- **Attestation is off until you provide an `IntegrityAttestor`.** The token reaches
  `verifyEnrollToken`, but it is not bound to a server challenge, so a captured token can be
  replayed. With no attestor, dash-ota does not prove the app is genuine or unmodified — the device
  key authenticates *the enrolled install*, not *app authenticity*.
- **`keyHardwareBacked` is self-reported.** The device says whether its key lives in secure
  hardware; the backend cannot check. iOS falls back to a software key when the Secure Enclave is
  unavailable, unless `OTA_REQUIRE_HARDWARE_KEY` is set.
- **Enrollment must be gated by you.** `installId` is non-secret and enroll overwrites the stored
  device key, so a production backend **must** wire `verifyEnrollToken` to bind enrollment to an
  authenticated session. The default only checks that a token is present, so without the hook
  anyone knowing an `installId` can impersonate that device.
- **No signed revocation, and no persisted downgrade floor.** `paused`/`rolledBack` are
  server-side-only state, and the downgrade guard compares against the running bundle only. A
  *breached* backend can't forge a bundle, but it can re-serve a signed release you rolled back, or
  an older one after a store update, `rollback()` or crash-loop revert. The crash-loop breaker is
  the client-side backstop for one that crashes.
- **No remote key revocation.** A binary trusts every signing key compiled into it. A leaked key
  stays trusted until your users install a store build without it.
- **The force-update policy is unsigned.** A breached server can send `severity: 'hard'` to every
  install. If your app blocks on `hard`, that locks users out on every launch where `/check`
  succeeds. See [If your server is breached](/docs/security/breach).
- **A fully-controlled (rooted/jailbroken) device** can tamper with its own process. Native
  verification stops *unverified bundles* from applying. Attestation at enrollment raises the bar
  against modified apps; it does not stop tampering at runtime.
- **One compressed blob is resident while it is decrypted.** Unpacking is otherwise file-to-file:
  the decompressed bundle, which is several times larger, is streamed to disk and never held. The
  remaining copy is unavoidable on both platforms — Apple's `AES.GCM.open` is one-shot, and Java's
  JCE will not release plaintext from `Cipher.update` before it has authenticated the tag
  (measured: `update` returned 0 bytes of a 1 MB message). Peak is set by the largest blob, which
  is the JS bundle.
- **iOS buffers a blob body before checking its size.** The download is rejected if it does not
  match the size the signed manifest promises, but iOS reads the body first; Android streams with a
  hard cap. Per-blob downloads make this far smaller than it used to be, but it is not yet a
  streaming bound.
- **Identical files are visibly identical across releases.** Encryption is convergent — the same
  file seals to the same bytes every time — which is what lets the store keep one copy. Anyone who
  can read the blob store can therefore tell which files did not change between two releases. The
  signed manifest already lists plaintext hashes, so this is not new information to anyone entitled
  to a manifest, but it is worth stating. One further consequence: because the content key is per
  channel, a leaked manifest exposes that channel's blobs rather than one release's. Blob reads are
  token-gated regardless, so this layer is defence in depth.
- **Encryption does not protect bundles on the device or from the server.** Devices store decrypted
  files, and the server, every enrolled install and an active MITM on unpinned `/check` requests can
  all get the content key. Rely on signing for integrity; treat encryption as protection for the
  blob store.
- **OTA updates JS, not native.** Native fixes still require a store release — that's what the
  [force-update gate](/docs/concepts/force-update) is for.

## Why state these

A control you can reason about precisely is worth more than a vague "bank-grade security" badge.
The guarantee dash-ota is built around, **a breached backend can't forge an update**, is also
available in Stallion, hot-updater, CodePush and Expo (EAS code signing needs a Production or
Enterprise plan) once you turn their code signing on. What differs here is that signing is
mandatory: there is no unsigned mode, and the server never holds the key.

→ [Threat model](/docs/security/threat-model)
