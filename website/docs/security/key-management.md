---
sidebar_position: 5
title: Keys, custody & rotation
---

# Keys, custody & rotation

There are three kinds of keys in dash-ota. One of them can forge an update; the other two cannot.

| Key | Type | Lives in | If compromised |
|---|---|---|---|
| Ed25519 **signing** key | private | CI secret, KMS or HSM | an attacker can sign updates every binary embedding the public key accepts, until those users take a store build without it |
| **Content** key (per channel) | symmetric, not secret | beside the signing key, `<keyId>.content.key` | blobs for that channel become readable; cannot forge anything |
| **Device** key | private | AndroidKeyStore / Secure Enclave (iOS software fallback) | requests can be signed as that one install, nothing more |
| Ed25519 **public** key ring | public | compiled into the app binary | safe to publish |

## The signing key

This is the only thing that can produce an update your users will accept, so treat it like a
production release secret. Keep it in CI secrets, a KMS or an HSM. Never a long-lived file on a
laptop, never in the repo — `*.private.pem` and `.keys/` are gitignored, and that is a backstop,
not a strategy.

Losing it means you cannot publish until you rotate. Leaking it is the emergency: anyone holding
it can sign releases that every binary embedding its public key accepts. Delivering them still
takes your admin token, your server, or a position on the network, but rotating does not help
installed apps. A binary trusts every key compiled into it, there is no remote revocation, and the
leaked key stays trusted until your users install a store build that drops it.

### Encrypted at rest unless you opt out

`keygen` encrypts the private key with a passphrase (AES-256-CBC, PKCS#8), so the file on disk
begins `BEGIN ENCRYPTED PRIVATE KEY`. `publish` decrypts it in memory only, to sign. In a terminal,
`keygen` asks for the passphrase, and an empty answer stores the key unencrypted. Without a
terminal (0.6.1 and later) it never prompts: it uses `--passphrase` or `OTA_KEY_PASSPHRASE`, or
`--no-encrypt` if you pass it, and otherwise fails.

```bash
dash-ota keygen --key-id key_prod_1                        # masked prompt
OTA_KEY_PASSPHRASE=… dash-ota keygen --key-id key_prod_1   # CI, non-interactive
dash-ota keygen --key-id key_prod_1 --no-encrypt           # opt out, warns loudly

OTA_KEY_PASSPHRASE=… dash-ota publish …                    # or --passphrase, or a prompt
```

Prefer `OTA_KEY_PASSPHRASE` or the prompt over `--passphrase`, which lands in process listings and
shell history.

`keygen` refuses to overwrite an existing signing key without `--force`, because every installed
app embeds the matching public key — silently replacing it would strand every device in the field.

### It verifies itself before uploading

`publish` verifies the manifest it just signed and aborts on a mismatch. By default it checks
against the sibling `<keyId>.public.json` (or, failing that, the public half of the signing key),
which only proves the key pair in `.keys/` is consistent. It says nothing about the key your app
embeds: if the app embeds a different public key, every device rejects the release with
`manifest signature did not verify`. To check against what the app embeds, pass
`--verify-pub <YOUR_PUBLIC_KEY_B64>`, where `<YOUR_PUBLIC_KEY_B64>` is the key as it appears in your
app's `ota_public_keys` (Android) or `OTA_PUBLIC_KEYS` (iOS).

## The content key

`<keyId>.content.key` is 32 bytes of base64 that seals the blobs. It is **not a secret** in the
way the signing key is: it rides inside every signed manifest, and the backend returns it on
`/check` to any enrolled install for the channel it asks about. What matters is that it stays
**identical for every release on a channel**. Encryption is convergent — the same file
seals to the same bytes every time — and that is what lets an unchanged file be stored and
downloaded once across releases. Change the content key and every file re-seals differently, so the
next release re-uploads in full.

Back it up with the signing key. Losing it does not stop you publishing, but it does silently cost
you every byte of deduplication on that channel.

## Rotating the signing key

The app trusts a **set** of public keys, and native accepts a manifest that verifies against any
one of them. It does not use the manifest's `keyId` to choose; `keyId` tells the backend which
registered key to check a publish against. The key ring is what makes rotation possible without
stranding anyone.

1. `dash-ota keygen --key-id key_prod_2`
2. Ship a transition build embedding **both** public keys — `ota_public_keys` on Android and
   `OTA_PUBLIC_KEYS` on iOS are comma-separated.
3. Wait for adoption of that build, register the new key with the backend
   (`dash-ota register-key --key-id key_prod_2 --key-file .keys/key_prod_2.public.json`), then start
   signing with `--key-id key_prod_2`.
4. Drop the old key in a later build.

Old installs keep verifying against the old key, which they still embed. New releases use the new
one. Skipping step 2 is what strands users: a release signed with a key no installed app knows
about fails verification on every device, and no OTA can fix it — the key ring is native, so the
recovery is a store release.

## Device keys

These rotate for free. Re-enrolling overwrites the stored public key for that install, so a wiped
or rotated keystore simply re-registers on the next launch.

## What the backend holds

Signing public keys to check publishes, device public keys to verify requests, and the signed
manifests, which include each channel's content key. No private key ever reaches it, which is why
a breached backend [cannot forge an update](/docs/security/breach).

Server-side commands fail closed: `register-key`, `publish`, `list` and the rollout operations all
require an admin token with no default, and plaintext `http://` to a non-local host is refused
unless you pass `--allow-insecure`.
