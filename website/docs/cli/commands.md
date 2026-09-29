---
sidebar_position: 3
title: Commands
---

# Commands

Every `dash-ota` command, its flags and their defaults. The same information is one command
away: `npx dash-ota <command> --help` (or `-h`) prints a command's flags, which ones are required,
and their defaults.

The examples assume `@dash-ota/cli` is installed in your app (`npm i -D @dash-ota/cli`) and are
run from the app root. Outside such a project, write `npx @dash-ota/cli` instead of
`npx dash-ota`. There is no npm package called just `dash-ota`.

Commands that talk to the backend take three shared flags, described in
[Overview](/docs/cli/overview):

| Flag | Default | Meaning |
|---|---|---|
| `--server <url>` | `$OTA_SERVER`, else `http://localhost:4455` | backend base URL |
| `--admin-token <token>` | `$OTA_ADMIN_TOKEN` | admin credential; required, there is no default |
| `--allow-insecure` | off | allow plain `http://` to a host other than `localhost` |

## Input checks

The CLI refuses input it can't use rather than guessing:

- A flag a command doesn't accept is an error, with the closest match suggested:

  ```
  ✗ unknown flag for `rollout`:
    --rollout   (did you mean --pct?)

    accepted: --bundle-id --pct --server --admin-token --allow-insecure --help
  ```

- A flag that takes a value must get one: `✗ --pct needs a value (--pct <0-100>)`.
- A switch takes no value: `✗ --mandatory is a switch and takes no value (got "yes")`.
- Numbers must be whole numbers in range:
  `✗ --min must be a whole number from 0 to 2147483647 (got "2.5.0")`. The ranges are 0–100 for
  percentages, 1–22 for `--compression-level`, and 1 or more for `--bundle-version`.
- An unknown command prints `✗ unknown command "<name>"` and exits 1.

Every error exits with status 1, so a CI step fails instead of carrying on.

## `keygen`

Generates an Ed25519 signing key pair and the channel content key.

```bash
npx dash-ota keygen --key-id key_prod_1
```

| Flag | Default | Meaning |
|---|---|---|
| `--out <dir>` | `.keys` | where the key files are written |
| `--key-id <id>` | `key_dev_1` | names the files and the manifest `keyId` |
| `--passphrase <passphrase>` | `$OTA_KEY_PASSPHRASE`, else a prompt in a terminal | encrypts the private key |
| `--no-encrypt` | off | store the private key unencrypted |
| `--content-key-only` | off | only add a missing `<key-id>.content.key` next to an existing signing key |
| `--force` | off | replace an existing signing key (apps that embed the old public key then reject every later release) |
| `--register` | off | register the new public key with the backend (needs `--admin-token`) |
| `--interactive` | off | ask whether to register the key |

It writes four files into `--out`: `<key-id>.private.pem`, `<key-id>.public.pem`,
`<key-id>.public.json` and `<key-id>.content.key`, and prints `publicKeyRawB64`, the value your app
embeds.

In a terminal it asks for a passphrase. An empty answer stores the key unencrypted and says so:
`⚠ no passphrase entered: the signing key will be stored UNENCRYPTED.` Without a terminal (CI) it
never prompts: give `--passphrase` or `OTA_KEY_PASSPHRASE`, or `--no-encrypt`, otherwise it stops
before writing anything:

```
✗ no passphrase for the signing key, and stdin is not a terminal to ask for one. Pass --passphrase <p> or set OTA_KEY_PASSPHRASE to encrypt it, or pass --no-encrypt to store it unencrypted.
```

Prefer `OTA_KEY_PASSPHRASE` over `--passphrase`: a command-line flag shows up in process listings
and shell history. `keygen` refuses to overwrite an existing key unless you pass `--force`.

`--server` and `--admin-token` alone don't register anything; add `--register`. See
[Keys, custody & rotation](/docs/security/key-management).

## `register-key`

Tells the backend to trust a public key.

```bash
npx dash-ota register-key --key-id key_prod_1 --key-file .keys/key_prod_1.public.json
```

| Flag | Default | Meaning |
|---|---|---|
| `--key-id <id>` | `key_dev_1` | the key id manifests carry |
| `--key-file <path>` | — | the `<key-id>.public.json` written by `keygen` |
| `--pub <rawB64>` | — | the public key as raw base64, instead of `--key-file` |

One of `--key-file` or `--pub` is required.

## `fingerprint`

Prints the runtime version `--runtime-version auto` would use for this project.

```bash
npx dash-ota fingerprint --project .
```

| Flag | Default | Meaning |
|---|---|---|
| `--project <path>` | current directory | React Native app root |

The value is a hash of every dependency in `package.json` (name and version range as written), the
React Native and Hermes versions, and the files under `android/` and `ios/`. Any dependency
change moves it, including a JavaScript-only one. Inside a git work tree only files git tracks
under `android/` and `ios/` count, so machine-local files such as `local.properties` or
`.xcode.env.local` don't make your laptop disagree with CI.

The app has to embed the same value, which is why the [quickstart](/docs/getting-started/quickstart)
uses a fixed string such as `rt1` instead. See
[Versioning & targeting](/docs/concepts/versioning-targeting).

## `bundle`

Runs `react-native bundle` into a payload directory, optionally compiled to Hermes bytecode.

```bash
npx dash-ota bundle --project . --platform android --out ./ota-out/android --hermes
```

| Flag | Default | Meaning |
|---|---|---|
| `--project <path>` | current directory | React Native app root |
| `--platform ios\|android` | `android` | target platform |
| `--out <dir>` | `<project>/.dash-ota-bundle/<platform>` | payload directory for `publish` |
| `--entry <file>` | `index.js` | JavaScript entry file, relative to `--project` |
| `--dev` | off | build a development bundle |
| `--hermes` | off | compile to Hermes bytecode with the app's own `hermesc`; fails if there is none |

Keep `--out` the same for every release. The server stores each distinct file once, so a stable
path lets unchanged files be skipped. `hermesc` is found in `react-native/sdks/hermesc` (React
Native 0.82 and older) or the `hermes-compiler` package (0.83 and later). See
[Hermes & HBC](/docs/cli/hermes).

## `publish`

Compresses, encrypts and signs a payload directory, then uploads only the files the server
doesn't already have.

```bash
npx dash-ota publish --bundle-dir ./ota-out/android --app-id com.example.app \
  --platform android --channel prod --key-id key_prod_1 \
  --runtime-version rt1 --bundle-version 7 --rollout 10 \
  --release-note "Fix order confirmation crash"
```

| Flag | Default | Meaning |
|---|---|---|
| `--bundle-dir <dir>` | — (required) | payload directory written by `bundle` |
| `--app-id <id>` | — (required) | Android `applicationId` / iOS bundle id; devices refuse a release for another app |
| `--platform ios\|android` | `android` | target platform |
| `--channel dev\|uat\|prod` | `dev` | release channel |
| `--runtime-version auto\|<value>` | `auto` | must equal the app's embedded runtime version; `auto` fingerprints `--project` |
| `--bundle-version <n>` | `1` | must be higher than the version the device runs |
| `--min-native-build <n>` | — | devices with a lower native build number skip this release |
| `--mandatory` | off | devices download and apply it without asking |
| `--target-app-versions <range>` | — | semver range over the app version, e.g. `">=1.2.0 <1.3.0"` |
| `--rollout <0-100>` | `100` | percentage of devices offered the release |
| `--release-note <text>` | — | "What's new" text |
| `--bundle-id <id>` | `bnd_<runtime>_<version>_<time>` | release id; a new one on every run |
| `--key <path>` | `.keys/<key-id>.private.pem` | signing key |
| `--key-id <id>` | `key_dev_1` | signing key id, registered with the backend |
| `--passphrase <passphrase>` | `$OTA_KEY_PASSPHRASE` | decrypts an encrypted signing key |
| `--verify-pub <rawB64>` | `<key-id>.public.json` next to `--key` | public key the signature is checked against before upload |
| `--no-encrypt` | off | store compressed plaintext; files are still hash-checked |
| `--content-key <base64>` | `$OTA_CONTENT_KEY`, else `<key dir>/<key-id>.content.key` | channel content key |
| `--compression-level <1-22>` | `19` | zstd level for the JS bundle |
| `--no-upload` | off | write the signed release next to `--bundle-dir` instead of uploading it |
| `--project <path>` | current directory | app root that `--runtime-version auto` fingerprints |
| `--interactive` | off | prompt for anything not given |

Output from a real run:

```
  ✓ self-verified signature (.keys/key_dev_1.public.json)

  bundleId:        bnd_rt1_2_mumketyh
  runtimeVersion:  rt1   bundleVersion: 2
  files:           1 (1 distinct blobs)   1.25 MB → 481.4 KB
  encryption:      aes-256-gcm
  uploading:       1 of 1 blobs (0 already present)   rollout: 100%
  uploaded 1/1
✓ published to http://localhost:4455: {"ok":true,"bundleId":"bnd_rt1_2_mumketyh","rolloutPercentage":100,"already":false}
```

The self-verify step checks the signature against the public key next to your private key (or
`--verify-pub`). It catches a damaged or mismatched key pair. It can't know which key your app
embeds: if that differs, every device rejects the release with
`manifest signature did not verify`.

A publish runs in three steps: declare the release, upload the missing files, finalize. Devices are
never offered a release until it is finalized. Re-running an interrupted publish creates a new
release with a new `bundleId`; the unfinished one shows as `INCOMPLETE` in `list` and is never
offered. A finalized release can't be changed: publishing the same `bundleId` again returns `409`.

Every release on a channel must use the same content key. `keygen` writes it next to the signing
key, and `publish` stops if it can't find it rather than making one up, because a new key per
release would re-upload every file every time.

`--min-native-build` stops a release reaching devices on an older store build. It sets a minimum
only: it doesn't stop an older release from installing on a newer build. The way to separate
native builds completely is a new `--runtime-version` for each store build that changes native code.

## `list`

```bash
npx dash-ota list
```

```
bnd_rt1_2_mumkmbz7  [android/dev]  rt=rt1 v2  100%  adoption={"applied":1,"healthy":1,"failed":0,"rolled_back":0}
```

Each line shows the release, its platform and channel, runtime version, bundle version, rollout
state and what devices have reported. The rollout column reads `PAUSED`, `ROLLED_BACK` or
`INCOMPLETE` instead of a percentage when that applies.

## `rollout`, `pause`, `rollback`

```bash
npx dash-ota rollout  --bundle-id <id> --pct 50
npx dash-ota pause    --bundle-id <id>            # add --resume to offer it again
npx dash-ota rollback --bundle-id <id>
```

| Command | Flags |
|---|---|
| `rollout` | `--bundle-id` (required), `--pct <0-100>` (default `100`) |
| `pause` | `--bundle-id` (required), `--resume` |
| `rollback` | `--bundle-id` (required) |

`publish` sets the first percentage with `--rollout`; the `rollout` command changes it with
`--pct`. The flag guard catches the mix-up.

A device is in a release's rollout when its bucket (the first 32 bits of
`sha256(installId:bundleId)`, mod 100) is below the percentage, so each release is offered to a different set of devices, and raising the percentage
only ever adds devices.

`rollback` pauses the release and flags it rolled back: `✓ release rolled back (paused + flagged)`.
`pause --resume` lifts the pause but not the flag, nothing clears the flag, and there is no delete.
A download already in progress gets `410` on its remaining files. Devices that already installed
the release keep it; to replace it, publish a fixed release with a higher `--bundle-version`. See
[Rollback](/docs/guides/rollback).

## `native-policy`

Sets a channel's [force-update gate](/docs/concepts/force-update): the lowest native build number
the channel still supports.

```bash
npx dash-ota native-policy --channel prod --min 42 --severity soft
```

| Flag | Default | Meaning |
|---|---|---|
| `--channel dev\|uat\|prod` | `dev` | channel the policy applies to |
| `--min <build>` | `0` | lowest native build number still supported |
| `--severity soft\|hard` | `hard` | what devices below `--min` are told; your app decides what each looks like |
| `--store-url <url>` | — | store link sent with the policy |

Mind the defaults: `native-policy --min 5` alone sets a **hard** gate on the **dev** channel.

The backend accepts only `https://`, `market://` and `itms-apps://` store links. Clients from
0.5.0 ignore the server's link and use `config.storeUrl` from the app, so `--store-url` only
matters for older clients.

## `dashboard`

Serves a local web page for the commands above, on `127.0.0.1` only.

```bash
npx dash-ota dashboard --config dash-ota.config.mjs
```

| Flag | Default | Meaning |
|---|---|---|
| `--config <path>` | `dash-ota.config.mjs` | environments file |
| `--port <n>` | `4460` | port on `127.0.0.1`; `0` picks a free one |
| `--no-open` | off | print the link without opening a browser |

See [Dashboard](/docs/cli/dashboard).
