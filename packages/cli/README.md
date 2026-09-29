# @dash-ota/cli

Release tooling for [dash-ota](https://github.com/Scripting-Bear/dash-ota) — the OTA update
system for React Native. This is the package that **holds the Ed25519 signing private key**
(CI / release env only): it bundles, encrypts, **signs**, and publishes updates. The backend
never sees the private key, so a breached backend cannot forge an update.

Ships as a single self-contained executable, runnable via `npx`.

> 📖 **Full command reference:** https://scripting-bear.github.io/dash-ota/docs/cli/commands

## Usage

```sh
npx dash-ota <command> [flags]
npx dash-ota <command> --help     # that command's flags, which are required, and their defaults
# or: npm i -g @dash-ota/cli   →   dash-ota <command>
```

### Release lifecycle

Run these from the app's root. The environment variables stand in for `--server`,
`--admin-token` and `--passphrase`; replace the values with your own.

```sh
export OTA_SERVER=https://ota.example.com
export OTA_ADMIN_TOKEN=replace-with-your-admin-token
export OTA_KEY_PASSPHRASE=replace-with-a-passphrase   # encrypts the signing key at rest

# 1. one signing keypair per environment (keep the private key in CI secrets only)
npx dash-ota keygen --key-id key_prod_1
npx dash-ota register-key --key-id key_prod_1 --key-file .keys/key_prod_1.public.json

# 2. bundle the JS as Hermes bytecode, then sign and publish it
npx dash-ota bundle --platform android --out ./out --hermes
npx dash-ota publish \
  --bundle-dir ./out --app-id com.example.app --platform android --channel prod \
  --key-id key_prod_1 --runtime-version auto --bundle-version 7 \
  --rollout 10 --release-note "Fix order confirmation crash"

# 3. operate: the bundle id is printed by publish and shown by list
npx dash-ota list
BUNDLE_ID=bnd_3f9a2c1d8e7b6a50_7_mfxk2q1z
npx dash-ota rollout  --bundle-id "$BUNDLE_ID" --pct 50
npx dash-ota pause    --bundle-id "$BUNDLE_ID"     # --resume to resume
npx dash-ota rollback --bundle-id "$BUNDLE_ID"
npx dash-ota native-policy --channel prod --min 42 --severity hard \
  --store-url "https://play.google.com/store/apps/details?id=com.example.app"
```

Commands: `keygen` · `register-key` · `fingerprint` (computes the native-compat `runtimeVersion`)
· `bundle` · `publish` · `list` · `rollout` · `pause` · `rollback` · `native-policy` · `dashboard`.

- `keygen` never prompts without a terminal: in CI set `OTA_KEY_PASSPHRASE` (or pass
  `--passphrase`), or pass `--no-encrypt` to store the key unencrypted on purpose.
- `publish --min-native-build <n>` makes devices on an older store build skip the release.
- `--runtime-version auto` changes with any `package.json` dependency change, JS-only ones
  included. In a git checkout it hashes only the files git tracks under `android/` and `ios/`.
- Keep `bundle --out` the same for every release: the server stores each distinct file once.
- A publish that is interrupted stays in `list` as `INCOMPLETE` and is never offered to devices.
  Publishing again creates a new release with a new bundle id.

Backend target via `--server` (env `OTA_SERVER`, default `http://localhost:4455`) and
`--admin-token` (env `OTA_ADMIN_TOKEN`, no default).

### Dashboard

```sh
npm i -D @dash-ota/cli
cp node_modules/@dash-ota/cli/dash-ota.config.example.mjs dash-ota.config.mjs   # then edit it
npx dash-ota dashboard
```

A local web UI (127.0.0.1 only) for the same operations. The example config ships in this package;
see the [dashboard docs](https://scripting-bear.github.io/dash-ota/docs/cli/dashboard).

## Key custody

Keep Ed25519 **private** keys in CI secrets / KMS / HSM — never commit them (`.keys/` and
`*.private.pem` are gitignored). Manifests carry a `keyId`; the app trusts a key ring, so keys
rotate via a transition build that trusts old + new before retiring the old.

## License

MIT
