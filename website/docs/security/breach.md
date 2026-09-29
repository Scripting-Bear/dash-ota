---
sidebar_position: 2
title: If your server is breached
---

# If your update server is breached

Assume the worst case. Someone has root on the machine serving your updates. They have the
database, the blob store, the admin token, and they can change any response the server sends.

This page is the honest answer to what happens next. It is the question most OTA tooling does not
answer, and it is the reason dash-ota is built the way it is.

## What they cannot do

**They cannot ship code to your users.** The Ed25519 private key lives in your CI or your key
store. It is never uploaded, never held by the backend, and never present in any request. The
device verifies every manifest against a public key compiled into the app binary, in native code,
before a single byte is written to disk. A manifest the attacker edits — even by one character —
fails that check and the update is discarded.

This holds even if TLS is completely broken. It does not depend on the network being honest.

Four more things the signature closes off, because each of these fields is inside the signed
manifest and therefore covered by it:

- **They cannot swap a file inside a release.** Every file carries its own SHA-256 in the manifest,
  and native re-hashes each one after decrypting. Blobs are addressed by content, so a substituted
  blob does not even resolve.
- **They cannot move a release between channels.** `channel` is signed, and the device checks it
  against the channel compiled into its own build.
- **They cannot aim a release at the wrong app.** `appId` is signed and compared to the running
  package name.
- **They cannot land a release on an incompatible binary.** `runtimeVersion` is signed, and the
  stored slot additionally records the native build number it was applied under. A slot that does
  not match both is dropped rather than loaded.

And they cannot roll you backwards: `bundleVersion` is monotonic, so a release older than the one
the device is running is refused.

## What they can do

Being honest about this is the point of the page.

**They can stop updates.** Returning `update: null` forever is indistinguishable from "you are up
to date". Your users keep running whatever they have. There is no client-side signal that this is
happening, so an update pipeline that has gone quiet deserves investigation rather than a shrug.

**They can re-serve a release you withdrew.** This is the sharpest one. `paused` and `rolledBack`
are server-side state, not signed facts. A release that was validly signed at some point, and
carries a higher `bundleVersion` than the device is running, can be served again by an attacker who
controls the server — including the bad release you rolled back an hour ago. The downgrade guard
blocks *older* versions; it has no way to know you withdrew a newer one.

The client-side backstop is the crash-loop breaker: if the re-served release crashes, it is
disabled after two boot attempts and the device reverts. That helps for a release that crashes. It
does nothing for one that merely misbehaves.

**They can force your users into an update wall.** This is the weakest link in the design, and it
is worth reading carefully:

```ts
// CheckResponse — note where the signature does and does not reach
{
  update: SignedManifest | null,   // ← signed, verified in native
  downloadToken?: string,
  serverNonce: string,
  nativePolicy: {                  // ← NOT signed. Sibling of the manifest.
    minSupportedNativeVersion: number,
    severity: 'none' | 'soft' | 'hard',
    storeUrl?: string,
  },
}
```

`nativePolicy` sits beside the signed manifest, not inside it, so all three of its fields are
whatever the server said.

**The destination is no longer one of them.** The client replaces `storeUrl` with your
`config.storeUrl` and drops the server's value outright — not scheme-checked and passed through,
dropped — because `https://attacker.example` passes any scheme check you could write. An attacker
cannot point your users anywhere.

**The decision still is.** `severity` and `minSupportedNativeVersion` are unsigned, so someone who
controls the backend can set `severity: 'hard'` for every install and hold the whole user base
behind a non-dismissible screen. For a trading app that is a denial of service with real cost,
timed at whatever moment suits them. `minSupportedNativeVersion` is the sharper of the two: it
decides whether the installed binary is allowed to run at all.

There is no client-side fix for that — a policy the server cannot set is a policy you cannot
change without a release. Closing it properly means signing the policy, which is
[on the roadmap](/docs/contributing/roadmap) as a protocol change rather than a patch.

:::warning[Set `config.storeUrl`]
Without it, `nativePolicy.storeUrl` is `undefined` and your force-update gate renders with no
link — the client will not fall back to the server's value. That is deliberate: a gate missing a
button is recoverable, a gate pointing at an attacker is not.

The backend also refuses to *store* a `storeUrl` that is not `https://` or `market://`, which
stops a leaked admin token from setting one. That is a separate control, and it does not help
against an attacker who owns the server — they bypass the server's own validation.
:::

**They can read your bundles.** They already hold the blobs, and the content key travels inside
the manifest, so they can decrypt them. Encryption here is defence in depth against someone
sniffing the wire or reading the blob store — it is not a defence against someone who owns the
server.

**They can enroll devices** if `verifyEnrollToken` is weak or absent, since `installId` is not a
secret and enrollment overwrites the stored device key. Bind enrollment to an authenticated
session; this is the one control the backend genuinely owns.

## What to do after a breach

1. **Rotate the admin token** and revoke the compromised host's access. The signing key does not
   need rotating — it was never there.
2. **Publish a new release with a higher `bundleVersion`** than anything that was ever signed for
   that channel. This is what displaces a re-served withdrawn release, because the device always
   prefers the highest eligible version.
3. **Pin your store URL in the app** if you have not already, then ship that as a store build.
4. **Re-register your public key** on the rebuilt backend before publishing, or `/admin/releases`
   rejects the release with `unknown_key`.

The key never needing rotation is the part worth noticing. In a system where the distribution
server signs, a breach means rotating the signing key, rebuilding every app that embeds it, and
shipping a store release to every user before you can safely publish again.

→ [Threat model](/docs/security/threat-model) · [Key custody](/docs/security/key-management) ·
[What dash-ota does not do](/docs/security/limitations)
