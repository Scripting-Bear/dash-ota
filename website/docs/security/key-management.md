---
sidebar_position: 4
title: Key management
---

# Key management

There are three kinds of keys. Two are private and must be protected; one is public per device.

| Key | Type | Lives in | If compromised |
|---|---|---|---|
| Ed25519 **signing** key | private | CI secret / KMS / HSM | attacker can forge updates → **rotate immediately** |
| Device key | private | AndroidKeyStore / Secure Enclave | non-exportable; bounded to one device |
| Ed25519 **public** key(s) | public | embedded in the app binary | safe to share |

## Signing key

- Keep it in **CI secrets / KMS / HSM** — never on a laptop, never in the repo. `*.private.pem` and
  `.keys/` are gitignored.
- Prefer KMS/HSM signing over a raw PEM where your tooling allows.

## Rotation (key ring)

The app trusts a **set** of public keys; manifests carry a `keyId`. Rotate without stranding users:

1. `dash-ota keygen --key-id key_prod_2`.
2. Ship a transition build embedding **both** keys (`ota_public_keys` is comma-separated).
3. Switch publishing to the new key once adoption of the transition build is high.
4. Drop the old key in a later build.

See [Key custody & rotation](/docs/cli/key-custody) for the CLI steps.

## Device key rotation

Device keys rotate for free — re-enrolling overwrites the stored public key for that install. A
wiped/rotated keystore simply re-registers on the next launch.

## Backend keys

The backend stores only **public** signing keys (to sanity-check publishes) and device **public**
keys (to verify requests). A full backend compromise leaks no private key and cannot forge updates.
