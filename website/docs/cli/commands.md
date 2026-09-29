---
sidebar_position: 3
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
| `--passphrase <p>` | prompt | encrypt the private key at rest (or `OTA_KEY_PASSPHRASE`) |
| `--no-encrypt` | — | store the private key unencrypted (warns) |
| `--server` / `--admin-token` | — | optionally register the new key immediately |

Writes `<key-id>.private.pem` (**encrypted** by default), `.public.pem`, `.public.json`; prints
`publicKeyRawB64`. See [Keys, custody & rotation](/docs/security/key-management).

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
dash-ota bundle --project . --platform android --out ./out --hermes [--dev] [--entry index.js]
```
> `--hermes` compiles the output to **HBC** with the binary's own `hermesc` (fails loud if missing).
> See [Hermes & HBC](/docs/cli/hermes).

> `keygen` also writes `<key-id>.content.key`, the channel content key used to seal blobs. Keep it
> alongside the signing key. Pass `--register` (with `--server` and an admin token) to register the
> public key in the same step; without `--interactive` it never prompts, so it is safe in CI.

## `publish`
Compress and seal each distinct file → **Ed25519-sign** the manifest → upload only the blobs the
server does not already hold.
```bash
dash-ota publish --bundle-dir ./out --app-id com.example.app --platform android --channel prod \
  --runtime-version auto --bundle-version 7 --rollout 10 \
  --release-note "Fix order confirmation crash" --key-id key_prod_1
```
| Flag | Meaning |
|---|---|
| `--bundle-dir <dir>` | payload dir (required) |
| `--app-id <id>` | **required** — package name / bundle id. A device refuses a manifest built for a different app |
| `--platform ios\|android` | target platform |
| `--channel dev\|uat\|prod` | release channel |
| `--runtime-version auto\|<R>` | `auto` = fingerprint the project |
| `--bundle-version <n>` | monotonic counter (downgrade guard) |
| `--target-app-versions "<range>"` | optional semver range over app version |
| `--rollout <0-100>` | staged rollout % |
| `--mandatory` | blocking update |
| `--release-note <txt>` | "What's New" note (or `--interactive` for `$EDITOR`) |
| `--key-id <id>` / `--key <pem>` | signing key (default `.keys/<key-id>.private.pem`) |
| `--passphrase <p>` | decrypt an encrypted signing key (or `OTA_KEY_PASSPHRASE`) |
| `--verify-pub <rawB64>` | public key to self-verify the signature against before upload |
| `--content-key <b64>` | channel content key; defaults to `<key dir>/<key-id>.content.key`, or `OTA_CONTENT_KEY` |
| `--no-encrypt` | store compressed plaintext; blobs are still hash-authenticated |
| `--compression-level <1-22>` | zstd level for the JS bundle (default 19) |
| `--no-upload` | write the signed artifact locally instead of uploading |
| `--interactive` | prompt for the fields above |

`publish` **self-verifies** the signature before upload (aborts on a key mismatch). Server access is
fail-closed: set `--admin-token`/`OTA_ADMIN_TOKEN`, and `http://` to a remote host is refused unless
`--allow-insecure`.

It runs in three steps — declare the release, upload the missing blobs, finalize — and prints what
that saved:

```
  files:           121 (121 distinct blobs)   27.92 MB → 9.44 MB   rollout: 10%
  encryption:      aes-256-gcm
  uploading:       2 of 121 blobs (119 already present)
```

Because a release is invisible to devices until it is finalized, an interrupted publish is safe to
re-run: it re-declares the same manifest and uploads only what is still missing. A **finalized**
release is immutable — re-publishing the same `bundleId` returns `409`, so publish a new
`bundleVersion` instead.

The content key must be the same for every release on a channel. `keygen` writes one next to the
signing key; if it is missing, `publish` fails rather than inventing one, because a per-release key
produces a perfectly valid release while silently re-uploading the entire bundle every time.

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

:::note[The percentage flag is named differently in the two places]
`publish` sets the initial percentage with **`--rollout`**; `rollout` changes it later with
**`--pct`**. Mixing them up used to be dangerous — `--pct` defaults to 100, so a typo'd
`rollout --rollout 50` quietly ramped to everyone. The CLI now refuses any flag a command does
not accept and points at the right one:

```
$ dash-ota rollout --bundle-id bnd_x --rollout 50
✗ unknown flag for `rollout`:
  --rollout   (did you mean --pct?)

  accepted: --bundle-id --pct --server --admin-token --allow-insecure
```
:::

`rollback` is **one-way**. It sets both `rolledBack` and `paused`, and while `pause --resume`
clears the pause, nothing clears `rolledBack` — devices holding a live download token start
getting 410 on the blobs. Recovering means publishing a new release; there is no unpublish.

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
