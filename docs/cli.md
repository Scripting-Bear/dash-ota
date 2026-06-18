# CLI — `@dash-ota/cli` (`dash-ota`)

The release tooling for dash-ota. This is the package that **holds the Ed25519 signing private
key** (CI / release env only): it bundles, encrypts, **signs**, and publishes updates. The
[backend](./backend.md) never sees the private key, so a breached backend cannot forge an update.

It ships as a single self-contained executable, runnable via `npx`.

---

## Install / run

```bash
# via npx (no global install)
npx dash-ota <command> [flags]

# or install
npm install -g @dash-ota/cli
dash-ota <command> [flags]
```

**Server / auth flags** (used by commands that talk to the backend):

| Flag | Env | Default | Meaning |
|---|---|---|---|
| `--server` | `OTA_SERVER` | `http://localhost:4455` | backend base URL |
| `--admin-token` | `OTA_ADMIN_TOKEN` | `dev-admin-token` | admin bearer (`/admin/*`) |

---

## Release lifecycle at a glance

```
keygen ─▶ register-key ─▶ (build app embedding the public key + runtimeVersion)
                                    │
   bundle ─▶ (hermesc → HBC) ─▶ publish ─▶ rollout ─▶ list / pause / rollback
```

---

## Commands

### `keygen` — generate a signing keypair
Creates an Ed25519 keypair. **Embed the public key in the app; keep the private key in CI secrets only.**

```bash
dash-ota keygen --key-id key_prod_1 --out .keys
# writes .keys/key_prod_1.{private.pem, public.pem, public.json}
# prints publicKeyRawB64 → put in OTA_PUBLIC_KEYS (Android resValue / iOS Info.plist)
```
Flags: `--out` (dir, default `.keys`), `--key-id` (default `key_dev_1`), optional `--server --admin-token` to register immediately.

### `register-key` — trust a public key on the backend
```bash
dash-ota register-key --key-id key_prod_1 --key-file .keys/key_prod_1.public.json
# or: --pub <publicKeyRawB64>
```

### `fingerprint` — compute the native-compatibility `runtimeVersion`
A hash of native inputs (RN version, Hermes, native deps, android/ios dirs). The **same** value
is embedded in the binary and stamped onto every OTA, so they always agree.
```bash
dash-ota fingerprint --project .
```

### `bundle` — produce the JS payload
Wraps `react-native bundle` into a payload dir (bundle + assets).
```bash
dash-ota bundle --project . --platform android --out ./out [--dev]
```
> For Hermes builds, compile the output to **HBC** with the binary's own `hermesc` before publish.
> The example's `scripts/publish-ota.mjs` does bundle → hermesc → publish in one step.

### `publish` — encrypt + sign + upload a release
AES-256-GCM encrypts, per-file SHA-256, builds + **Ed25519-signs** the manifest, then uploads.
```bash
dash-ota publish \
  --bundle-dir ./out --platform android --channel prod \
  --runtime-version auto --bundle-version 7 \
  --rollout 10 --release-note "Fix order confirmation crash" \
  --key-id key_prod_1
```
Key flags:

| Flag | Meaning |
|---|---|
| `--bundle-dir <dir>` | payload dir (from `bundle`) — required |
| `--platform ios\|android` | target platform |
| `--channel dev\|uat\|prod` | release channel |
| `--runtime-version auto\|<R>` | `auto` = fingerprint the project (recommended) |
| `--bundle-version <n>` | monotonic counter (downgrade guard) |
| `--target-app-versions "<range>"` | optional semver range over app version |
| `--rollout <0-100>` | staged rollout % |
| `--mandatory` | blocking update |
| `--release-note <txt>` | "What's New" note (or `--interactive` for `$EDITOR`) |
| `--key-id <id>` / `--key <pem>` | signing key (defaults to `.keys/<key-id>.private.pem`) |
| `--no-upload` | write the signed artifact locally instead of uploading |
| `--interactive` | prompt for the fields above (CI-friendly flags otherwise) |

### `list` — releases + adoption/health
```bash
dash-ota list
```

### Operate rollouts
```bash
dash-ota rollout  --bundle-id <id> --pct 50      # ramp the rollout
dash-ota pause    --bundle-id <id>               # pause (add --resume to resume)
dash-ota rollback --bundle-id <id>               # roll back (pause + flag)
```

### `native-policy` — force-update gate
Sets the minimum supported native build per channel; below it the client shows a `hard` gate
(blocking "update from store") or a `soft` nudge.
```bash
dash-ota native-policy --channel prod --min 42 --severity hard --store-url "https://apps.apple.com/app/id…"
```

---

## Per-environment keys (dev / uat / prod)

One keypair per environment; private keys live in CI/KMS, never in the app or repo
(`.keys/` and `*.private.pem` are gitignored):

```bash
dash-ota keygen --key-id key_dev_1   # → embed publicKeyRawB64 in the dev flavour
dash-ota keygen --key-id key_uat     # → uat
dash-ota keygen --key-id key_prod    # → prod
dash-ota register-key --key-id <id> --key-file .keys/<id>.public.json
```

Each flavour embeds **its own** public key + channel, so an OTA can only reach the matching
flavour and only if signed by that environment's key — a bundle signed with the wrong key is
rejected natively.

---

## Key custody

- Keep Ed25519 **private** keys in CI secrets / KMS / HSM — never commit them.
- Manifests carry a `keyId`; the app trusts a **key ring**, so a key can be rotated across a
  transition build that trusts old + new before retiring the old.
- Loss of the private key = can't publish (recoverable via rotation); leak = can forge updates
  until rotated — treat it like a production signing secret.
