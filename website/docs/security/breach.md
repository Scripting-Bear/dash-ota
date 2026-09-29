---
sidebar_position: 2
title: If your server is breached
---

# If your update server is breached

Assume the worst case. Someone has root on the machine serving your updates. They have the
database, the blob store, the admin token, and they can change any response the server sends.

This page lists what they can and cannot do to your users from there.

## What they cannot do

**They cannot forge or modify a release.** The Ed25519 private key lives in your CI or your key
store. It is never uploaded, never held by the backend, and never present in any request. The
device verifies every manifest against the public keys compiled into the app binary, in native
code, before it writes anything to disk. A manifest changed by even one character fails that check
and the update is discarded.

This holds even if TLS is completely broken. It does not depend on the network being honest.

The signature covers every field in the manifest, which closes off a few more things:

- **They cannot swap a file inside a release.** Every file carries its own SHA-256 in the manifest.
  Native checks each blob's hash before decrypting it and each file's hash after unpacking it.
- **They cannot aim a release at the wrong app or binary.** `appId` is signed and compared to the
  running package name or bundle identifier. `runtimeVersion` is signed and must equal the one
  compiled into the binary. From client 0.5.1, a signed `minNativeBuild` above the installed native
  build is refused too.
- **They cannot move a release to another channel or platform** (client 0.5.1 and later). `channel`
  and `platform` are signed, and native compares them to the binary's own. Before 0.5.1 only the
  server checked them, so a breached server could hand one channel's release to a binary on
  another channel, if that binary's key ring trusts the key that signed it.
- **They cannot send users to their own store link** (client 0.5.0 and later). The client drops
  the server's `storeUrl` and uses your `config.storeUrl` instead. More on this below.

**They cannot run code on the device.** Anything the update path installs was signed by your key.
The parts of the response they do control (whether an update is offered, the force-update policy,
the download token) are data your app reads, never code.

## What they can do

**They can withhold updates.** Returning `update: null` forever looks exactly like "you are up to
date", and they can choose per install. Your users keep running what they have. Nothing on the
device signals that this is happening, so an update pipeline that has gone quiet is worth
investigating.

**They can re-serve an older or withdrawn release that is still validly signed.** `paused` and
`rolledBack` are server-side flags, not part of anything signed. The device's only defence is the
downgrade guard, which refuses a release whose `bundleVersion` is not higher than the bundle it is
running right now. Nothing is persisted beyond that, so a signed release for the same app,
`runtimeVersion`, channel and platform installs whenever its `bundleVersion` is higher than what the
device currently runs. That covers:

- a release you rolled back or paused, on any device still below it (including devices that never
  took it);
- after a store update that changes the native build number: the new binary drops the old
  binary's bundles and runs the embedded one (version 0), so any OTA for that `runtimeVersion` is
  accepted, however old;
- after the app calls `rollback()`, or after a crash-loop revert, when the device runs an older
  bundle than before. A bundle the crash-loop breaker disabled is never installed again on that
  device.

They cannot forge a release to fill a gap, only re-send ones you signed. Changing `runtimeVersion`
with every store build closes the store-update case, because no older OTA matches the new binary.
If a re-served release crashes, the [crash-loop breaker](/docs/concepts/crash-loop) disables it and
reverts. That does nothing for a release that runs but misbehaves.

**They can force a hard update prompt.** The force-update policy travels beside the signed manifest,
not inside it:

```ts
// CheckResponse: what the signature covers and what it doesn't
{
  update: SignedManifest | null,   // signed, verified in native
  downloadToken?: string,          // not signed
  serverNonce: string,             // not signed
  nativePolicy: {                  // not signed
    minSupportedNativeVersion: number,
    severity: 'none' | 'soft' | 'hard',
    storeUrl?: string,
  },
}
```

The server computes `severity` from the device's native build and `minSupportedNativeVersion`; the
client does not check that arithmetic. So an attacker can send `severity: 'hard'` to every install.
The library itself renders nothing. What happens next is up to your app: if it shows a blocking
screen on `hard`, as the [force-update recipe](/docs/concepts/force-update) does, users are locked
out on every launch where `/check` succeeds. The policy is not stored on the device, so the app
still opens offline. This is a denial of service, not code execution. If a lock-out you cannot
lift without the server is unacceptable, give the hard gate a way out in your app, for example a
"continue anyway" option that appears once the store link has been opened.

Where the gate's button points is a separate question:

- **Client 0.5.0 and later** ignore the server's `storeUrl`. The gate uses your `config.storeUrl`,
  and only if it starts with `https://`, `market://` or `itms-apps://`. Without a valid
  `config.storeUrl` the gate has no link, and the dropped server value is logged as a warning.
- **Clients before 0.5.0** open whatever `storeUrl` the server sends. Backend 0.5.1 only stores an
  `https://`, `market://` or `itms-apps://` URL with no credentials or whitespace, and drops stored
  values that fail that check. That limits the scheme a leaked admin token can set, but any `https`
  host passes, so it does not stop a phishing link. It does nothing against someone who owns the
  server, because they can bypass the server's own validation. Old clients get a trustworthy link
  only from a store build on 0.5.0 or later.

Signing the policy is [on the roadmap](/docs/contributing/roadmap).

**They can make iOS downloads use a lot of memory.** iOS reads a blob's whole response into memory
before comparing its size with the signed one, so an oversized response is refused only after it
has been held. Android stops reading as soon as a download passes the signed size.

**They can read your bundles.** They hold the blobs, and every manifest carries the content key, so
they can decrypt everything. Encryption keeps blob bytes unreadable to someone who can read the
blob store or a cache in front of it but not the manifests. It does not hide anything from whoever
runs the server.

**They can collect enrollment tokens.** The client sends whatever your `getEnrollToken` returns on
`/enroll`, and a server that answers a check with `not_enrolled` makes the client enroll again. If
that function returns your app's main session token, a breached server can harvest it from every
active install. Hand it a short-lived token that is only good for enrollment.

**They can falsify release state and adoption numbers.** Rollout percentages, pause flags,
auto-pause and the adoption counts in `list`, the dashboard and your `onConfirm` hook all live on
the server, so they show whatever the attacker writes. None of it reaches a device except as
"offer this release or not".

Enrollment and request signing protect the server from fake devices. They do not protect devices
from the server.

## What to do after a breach

1. **Rotate the admin token** and revoke the compromised host's access. The signing key does not
   need rotating, because it was never there.
2. **Treat enrollment tokens sent during the breach as exposed**, and revoke them if they are
   session tokens.
3. **Re-register your public key** on the rebuilt backend before publishing, or `/admin/releases`
   rejects the release with `unknown_key`.
4. **Publish a new release with a higher `bundleVersion`** than anything ever signed for that
   runtime and channel. Once a device runs it, the downgrade guard refuses every lower version
   until the next store update, `rollback()` or crash-loop revert.
5. **Set `config.storeUrl` in the app** if you have not already, and ship it in a store build.
   Clients older than 0.5.0 need that store build before their gate link is safe.

A breach of this server never forces a key rotation or an emergency store release to restore
integrity. That is what keeping the signing key off the server buys.

→ [Threat model](/docs/security/threat-model) · [Key custody](/docs/security/key-management) ·
[What dash-ota does not do](/docs/security/limitations)
