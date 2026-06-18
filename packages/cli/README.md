# @dash-ota/cli

Release tooling for [dash-ota](https://github.com/Scripting-Bear/dash-ota) — the OTA update
system for React Native. This is the package that **holds the Ed25519 signing private key**
(CI / release env only): it bundles, encrypts, **signs**, and publishes updates. The backend
never sees the private key, so a breached backend cannot forge an update.

Ships as a single self-contained executable, runnable via `npx`.

> 📖 **Full command reference:** https://github.com/Scripting-Bear/dash-ota/blob/main/docs/cli.md

## Usage

```sh
npx dash-ota <command> [flags]
# or: npm i -g @dash-ota/cli   →   dash-ota <command>
```

### Release lifecycle

```sh
# 1. one signing keypair per environment (keep the private key in CI secrets only)
npx dash-ota keygen --key-id key_prod_1
npx dash-ota register-key --key-id key_prod_1 --key-file .keys/key_prod_1.public.json

# 2. bundle the JS (compile to Hermes HBC for Hermes builds) then publish a signed release
npx dash-ota publish \
  --bundle-dir ./out --platform android --channel prod \
  --runtime-version auto --bundle-version 7 \
  --rollout 10 --release-note "Fix order confirmation crash"

# 3. operate
npx dash-ota list
npx dash-ota rollout  --bundle-id <id> --pct 50
npx dash-ota pause    --bundle-id <id>     # --resume to resume
npx dash-ota rollback --bundle-id <id>
npx dash-ota native-policy --channel prod --min 42 --severity hard --store-url <url>
```

Commands: `keygen` · `register-key` · `fingerprint` (computes the native-compat `runtimeVersion`)
· `bundle` · `publish` · `list` · `rollout` · `pause` · `rollback` · `native-policy`.

Backend target via `--server` (env `OTA_SERVER`, default `http://localhost:4455`) and
`--admin-token` (env `OTA_ADMIN_TOKEN`). Full flags per command in the
[reference](https://github.com/Scripting-Bear/dash-ota/blob/main/docs/cli.md).

## Key custody

Keep Ed25519 **private** keys in CI secrets / KMS / HSM — never commit them (`.keys/` and
`*.private.pem` are gitignored). Manifests carry a `keyId`; the app trusts a key ring, so keys
rotate via a transition build that trusts old + new before retiring the old.

## License

MIT
