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

## Encryption at rest

`keygen` encrypts the private key with a passphrase by default (AES-256-CBC / PKCS#8) — the file on
disk is a `BEGIN ENCRYPTED PRIVATE KEY`. `publish` decrypts it **in memory only** to sign.

```bash
# passphrase from a prompt (masked), a flag, or the environment
dash-ota keygen --key-id key_prod_1                 # prompts (input hidden)
OTA_KEY_PASSPHRASE=… dash-ota keygen --key-id key_prod_1   # CI / non-interactive
dash-ota keygen --key-id key_prod_1 --no-encrypt    # opt out (warns loudly)

# publishing an encrypted key:
OTA_KEY_PASSPHRASE=… dash-ota publish …             # or --passphrase, or a prompt
```

Prefer `OTA_KEY_PASSPHRASE` (or the masked prompt) over `--passphrase`, which is visible in process
listings / shell history.

## Self-verify before upload

`publish` verifies the freshly-signed manifest against the public key the app embeds — `--verify-pub
<rawB64>`, else the sibling `<keyId>.public.json`, else a consistency check against the signing key —
and **aborts on mismatch**. This catches a wrong-key / `keyId` mismatch *before* shipping an update
that every device would reject.

## Fail-closed admin & transport

Server commands (`register-key`, `publish`, `list`, rollout ops) require an admin token — there is
**no default**; set `--admin-token` or `OTA_ADMIN_TOKEN` or the command errors. Plaintext `http://`
to a non-local host is refused (use `https://`, or `--allow-insecure` on a trusted network).

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
