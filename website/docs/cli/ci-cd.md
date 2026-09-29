---
sidebar_position: 6
title: CI/CD integration
---

# CI/CD integration

Publish from CI with the signing key kept in your CI's secret store. The CLI never prompts when
there is no terminal, and every error exits with status 1, so a failed step stops the job.

## What CI needs

`@dash-ota/cli` must be in your app's `devDependencies` (`npm i -D @dash-ota/cli`), so `npm ci`
installs it and `npx dash-ota` runs that copy.

| Secret or variable | What it is | How the CLI reads it |
|---|---|---|
| `OTA_SIGNING_KEY_PROD` (secret) | contents of `.keys/key_prod_1.private.pem` | written to that file by a step |
| `OTA_KEY_PASSPHRASE` (secret) | the passphrase that encrypts it | environment variable |
| `OTA_CONTENT_KEY` (secret) | contents of `.keys/key_prod_1.content.key` | environment variable |
| `OTA_ADMIN_TOKEN` (secret) | the backend admin token | environment variable |
| `OTA_SERVER` (variable) | your backend's base URL | environment variable |
| `OTA_APP_PUBLIC_KEY` (variable) | the `publicKeyRawB64` your prod app embeds | passed as `--verify-pub` |

`--verify-pub` makes `publish` check the signature against the key your app really embeds, so a
job signing with the wrong key fails before it uploads anything. The public key isn't secret.

## GitHub Actions

```yaml title=".github/workflows/ota.yml"
name: Publish OTA
on:
  workflow_dispatch:
    inputs:
      platform: { description: 'android or ios', required: true, default: android }
      bundleVersion: { description: 'bundle version (higher than the last one)', required: true }

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with: { node-version: '20.19' }
      - run: npm ci

      - name: Restore the signing key
        run: |
          mkdir -p .keys
          printf '%s\n' "$OTA_SIGNING_KEY" > .keys/key_prod_1.private.pem
        env:
          OTA_SIGNING_KEY: ${{ secrets.OTA_SIGNING_KEY_PROD }}

      - name: Bundle
        run: npx dash-ota bundle --project . --platform ${{ inputs.platform }} --out ./ota-out/${{ inputs.platform }} --hermes

      - name: Publish
        env:
          OTA_SERVER: ${{ vars.OTA_SERVER }}
          OTA_ADMIN_TOKEN: ${{ secrets.OTA_ADMIN_TOKEN }}
          OTA_KEY_PASSPHRASE: ${{ secrets.OTA_KEY_PASSPHRASE }}
          OTA_CONTENT_KEY: ${{ secrets.OTA_CONTENT_KEY }}
        run: |
          npx dash-ota publish \
            --bundle-dir ./ota-out/${{ inputs.platform }} \
            --platform ${{ inputs.platform }} --channel prod \
            --app-id com.example.app \
            --key-id key_prod_1 --verify-pub "${{ vars.OTA_APP_PUBLIC_KEY }}" \
            --runtime-version rt1 \
            --bundle-version ${{ inputs.bundleVersion }} \
            --rollout 10
```

Replace `com.example.app` with your app id, and `rt1` with the runtime version your prod build
embeds. `bundle --hermes` on Linux uses the Linux `hermesc` that ships with React Native, so an
Ubuntu runner can build both platforms' bundles.

If you use `--runtime-version auto` instead, the fingerprint must come out the same in CI as in the
build you shipped. It only counts files git tracks, so a clean checkout of the commit you built
the store release from gives the same value as your machine.

Never commit the private key. If you can, sign with a key held in a KMS or HSM rather than a PEM
file in CI.

## Ramping and pulling back from CI

Add `workflow_dispatch` jobs for `npx dash-ota rollout --bundle-id <id> --pct <n>`, `pause` and
`rollback`, so every change to a live release goes through CI and shows up in its history.

## Both platforms

Android and iOS each need their own bundle and their own release. Run the job once per platform,
or as a matrix:

```yaml
strategy:
  matrix:
    platform: [android, ios]
steps:
  # ...checkout, setup-node, npm ci and the key restore step as above...
  - run: npx dash-ota bundle --project . --platform ${{ matrix.platform }} --out ./ota-out/${{ matrix.platform }} --hermes
  - run: >-
      npx dash-ota publish --bundle-dir ./ota-out/${{ matrix.platform }}
      --platform ${{ matrix.platform }} --channel prod --app-id com.example.app
      --key-id key_prod_1 --verify-pub "${{ vars.OTA_APP_PUBLIC_KEY }}"
      --runtime-version rt1 --bundle-version ${{ inputs.bundleVersion }} --rollout 10
```

Each platform's release gets its own `bundleId` and its own rollout percentage. If your Android
and iOS app ids differ, pass each one's own `--app-id`.
