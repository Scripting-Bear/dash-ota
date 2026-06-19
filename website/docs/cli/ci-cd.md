---
sidebar_position: 6
title: CI/CD integration
---

# CI/CD integration

Publish OTAs from CI with the signing key kept in a secret. The CLI is `npx`-executable and parses
cleanly for automation.

## GitHub Actions

```yaml title=".github/workflows/ota.yml"
name: Publish OTA
on:
  workflow_dispatch:
    inputs:
      channel: { description: channel, default: prod }
      bundleVersion: { description: bundleVersion, required: true }

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm ci

      # restore the Ed25519 private key from a secret
      - run: |
          mkdir -p .keys
          echo "${{ secrets.OTA_SIGNING_KEY_PROD }}" > .keys/key_prod.private.pem

      - name: Bundle (+ Hermes HBC)
        run: node scripts/publish-bundle.mjs --platform android --out ./out

      - name: Publish
        env:
          OTA_SERVER: ${{ secrets.OTA_SERVER }}
          OTA_ADMIN_TOKEN: ${{ secrets.OTA_ADMIN_TOKEN }}
        run: |
          npx dash-ota publish \
            --bundle-dir ./out --platform android \
            --channel ${{ inputs.channel }} \
            --runtime-version auto \
            --bundle-version ${{ inputs.bundleVersion }} \
            --rollout 10 --key-id key_prod
```

## Secrets

| Secret | What |
|---|---|
| `OTA_SIGNING_KEY_PROD` | the Ed25519 **private** PEM (or pull from KMS) |
| `OTA_SERVER` | your backend base URL |
| `OTA_ADMIN_TOKEN` | the backend admin token |

> Never commit the private key. Prefer KMS/HSM signing over a raw PEM in CI where possible.

## Ramp & rollback from CI

Wire follow-up jobs (or a manual `workflow_dispatch`) to `dash-ota rollout --pct …` and
`dash-ota rollback` so ramps and pulls are auditable.
