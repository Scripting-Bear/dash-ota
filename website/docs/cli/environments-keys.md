---
sidebar_position: 4
title: Per-environment keys
---

# Per-environment keys

Use **one signing keypair per environment**. Each build flavour embeds its environment's **public**
key, so an OTA signed with one environment's key can't apply on another's build.

```bash
dash-ota keygen --key-id key_dev_1   # → embed publicKeyRawB64 in the dev flavour
dash-ota keygen --key-id key_uat     # → uat
dash-ota keygen --key-id key_prod    # → prod
dash-ota register-key --key-id <id> --key-file .keys/<id>.public.json
```

- **Private keys** live in CI secrets / KMS — never in the app or repo. `.keys/` and
  `*.private.pem` are gitignored.
- **Public keys** are embedded per flavour (Android `ota_public_keys` / iOS `OTA_PUBLIC_KEYS`).
- When you `publish`, pass the matching `--key-id`; the manifest records its `keyId` and the app
  verifies against the embedded key for that environment.

This gives you **key isolation**: even if a dev key leaked, it couldn't push to prod builds (which
embed only the prod key). See [Environments & flavours](/docs/react-native/environments) for the
client side and [Key custody](/docs/cli/key-custody) for rotation.
