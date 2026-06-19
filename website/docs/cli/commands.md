---
sidebar_position: 2
title: Commands
---

# Commands

Every `dash-ota` command and its flags. Backend-talking commands also accept `--server` /
`--admin-token` (see [overview](/docs/cli/overview)).

## `keygen`
Generate an Ed25519 signing keypair. **Embed the public key in the app; keep the private key in CI secrets.**
```bash
dash-ota keygen --key-id key_prod_1 --out .keys
```
| Flag | Default | Meaning |
|---|---|---|
| `--out` | `.keys` | output directory |
| `--key-id` | `key_dev_1` | key identifier (becomes the filename + manifest `keyId`) |
| `--server` / `--admin-token` | — | optionally register the new key immediately |

Writes `<key-id>.private.pem`, `.public.pem`, `.public.json`; prints `publicKeyRawB64`.

## `register-key`
Tell the backend to trust a public key.
```bash
dash-ota register-key --key-id key_prod_1 --key-file .keys/key_prod_1.public.json
# or: --pub <publicKeyRawB64>
```

## `fingerprint`
Compute the native-compatibility `runtimeVersion` (a hash of RN version, Hermes, native deps, and
the android/ios dirs).
```bash
dash-ota fingerprint --project .
```

## `bundle`
Wrap `react-native bundle` into a payload dir (bundle + assets).
```bash
dash-ota bundle --project . --platform android --out ./out [--dev] [--entry index.js]
```
> For Hermes builds, compile the output to **HBC** with the binary's own `hermesc` before publish.

## `publish`
AES-256-GCM encrypt → per-file SHA-256 → **Ed25519-sign** the manifest → upload.
```bash
dash-ota publish --bundle-dir ./out --platform android --channel prod \
  --runtime-version auto --bundle-version 7 --rollout 10 \
  --release-note "Fix order confirmation crash" --key-id key_prod_1
```
| Flag | Meaning |
|---|---|
| `--bundle-dir <dir>` | payload dir (required) |
| `--platform ios\|android` | target platform |
| `--channel dev\|uat\|prod` | release channel |
| `--runtime-version auto\|<R>` | `auto` = fingerprint the project |
| `--bundle-version <n>` | monotonic counter (downgrade guard) |
| `--target-app-versions "<range>"` | optional semver range over app version |
| `--rollout <0-100>` | staged rollout % |
| `--mandatory` | blocking update |
| `--release-note <txt>` | "What's New" note (or `--interactive` for `$EDITOR`) |
| `--key-id <id>` / `--key <pem>` | signing key (default `.keys/<key-id>.private.pem`) |
| `--no-upload` | write the signed artifact locally instead of uploading |
| `--interactive` | prompt for the fields above |

## `list`
```bash
dash-ota list   # releases + adoption/health per channel
```

## `rollout` · `pause` · `rollback`
```bash
dash-ota rollout  --bundle-id <id> --pct 50
dash-ota pause    --bundle-id <id>            # add --resume to resume
dash-ota rollback --bundle-id <id>            # pause + flag
```

## native-policy
Set the [force-update gate](/docs/concepts/force-update) per channel.
```bash
dash-ota native-policy --channel prod --min 42 --severity hard --store-url "https://..."
```
| Flag | Meaning |
|---|---|
| `--channel <c>` | channel |
| `--min <build>` | minimum supported native build number |
| `--severity soft\|hard` | nudge vs blocking gate |
| `--store-url <url>` | store deep-link |
