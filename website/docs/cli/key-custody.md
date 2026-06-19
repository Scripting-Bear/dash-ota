---
sidebar_position: 7
title: Key custody & rotation
---

# Key custody & rotation

The Ed25519 **private** signing key is the crown jewel — it's the one thing that can forge an
update. Treat it like a production signing secret.

## Custody rules

- Keep private keys in **CI secrets / KMS / HSM** — never a long-lived file on a laptop, never in
  the repo (`*.private.pem` and `.keys/` are gitignored).
- **Loss** = you can't publish (recoverable via rotation).
- **Leak** = an attacker can forge updates **until you rotate** — so rotate immediately on
  suspicion.

## Key ring & rotation

The app trusts a **set** of public keys (a key ring), and each manifest carries a `keyId`. This
lets you rotate without bricking existing installs:

1. Generate a new key: `dash-ota keygen --key-id key_prod_2`.
2. Ship a **transition build** that embeds **both** the old and new public keys
   (`ota_public_keys` is comma-separated).
3. Once enough users are on the transition build, start signing with the new key
   (`--key-id key_prod_2`).
4. In a later build, drop the old key.

Old installs verify against the old key (still embedded); new releases use the new key. No user is
stranded.

## Backend's role

The backend only ever holds **public** keys (registered via `register-key`) to sanity-check
publishes. Even a full backend compromise can't forge an update — the private key never reaches it.

→ [Security: key management](/docs/security/key-management)
