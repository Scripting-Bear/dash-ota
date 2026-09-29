---
sidebar_position: 2
title: The dashboard
description: A local web page for publishing, ramping and rolling back releases.
---

# The dashboard

```bash
npx dash-ota dashboard
```

```
dash-ota dashboard → http://127.0.0.1:4460/#t=8Kd2…
  local only (127.0.0.1) · the link carries this session's token · Ctrl+C to stop
```

A web page that runs on your machine and talks straight to your backends. It publishes releases,
ramps and pauses rollouts, rolls releases back and sets the force-update policy: the same
operations as the CLI, with a release table and a live publish log instead of flags. Nothing is
hosted anywhere else, and nothing leaves your machine except the calls to your own backend.

## Set it up

The dashboard reads your environments from a config file. Start from the example that ships with
the CLI:

```bash
cp node_modules/@dash-ota/cli/dash-ota.config.example.mjs dash-ota.config.mjs
```

It looks like this:

```js title="dash-ota.config.mjs"
export default {
  environments: {
    dev: {
      server: 'http://localhost:4455',
      adminToken: process.env.OTA_ADMIN_TOKEN_DEV,
      channel: 'dev',
      appId: 'com.your.app.dev',
      runtimeVersion: 'rt1',
      keyId: 'key_dev_1',
      keyPath: '.keys/key_dev_1.private.pem',
    },
    prod: {
      server: 'https://ota.yourapi.com',
      adminToken: process.env.OTA_ADMIN_TOKEN_PROD,
      channel: 'prod',
      appId: 'com.your.app',
      runtimeVersion: 'rt1',
      keyId: 'key_prod_1',
      keyPath: '.keys/key_prod_1.private.pem',
      platforms: ['android', 'ios'],
      protected: true,
    },
  },
};
```

The admin tokens come from the environment, so export them first, then start it:

```bash
export OTA_ADMIN_TOKEN_DEV=<YOUR_DEV_ADMIN_TOKEN>
npx dash-ota dashboard
```

It opens your browser automatically. Pass `--no-open` to stop that, `--port <n>` to move it off
4460, and `--config <path>` if the file lives somewhere else.

### Every field

| Field | Required | What it does |
|---|---|---|
| `server` | yes | backend base URL. Plain `http://` is refused for non-local hosts |
| `channel` | yes | `dev`, `uat` or `prod` |
| `appId` | yes | your application id, signed into every manifest |
| `runtimeVersion` | yes | the runtime version to publish under; see the warning below |
| `keyId` | yes | which signing key to use |
| `keyPath` | yes | path to the private key, relative to the project |
| `adminToken` | no | without it the environment appears, but its releases can't be listed or changed |
| `contentKeyPath` | no | defaults to `<keyId>.content.key` beside the signing key |
| `passphrase` | no | for an encrypted signing key; falls back to `OTA_KEY_PASSPHRASE` |
| `platforms` | no | which platforms the New-release dialog offers |
| `protected` | no | every write requires typing the environment's name to confirm |

Two more at the top level: `project` sets the app root relative to the config file, and `bundle`
replaces the default build step if you don't use plain `react-native bundle` plus `hermesc`:

```js
bundle: async ({ platform, out, project, log }) => {
  log(`building ${platform}`);
  await myCustomBundler({ platform, out, project });
},
```

Relative paths resolve against `project`. The config is an ES module and is imported, so it can
read environment variables and compute values. That is how `adminToken` stays out of the file.

:::warning[`runtimeVersion` is a fixed string here]
The dashboard publishes under the string in the config; it never fingerprints. That string has
to equal the runtime version embedded in the binaries you mean to reach. When you change native
code, change it in both places (the app's build config and here) in the same commit. If you
forget, the new JavaScript is offered to older binaries that embed the old string and lack the new
native code, and it crashes there until the crash-loop breaker reverts it.
:::

## What it does

**Environment tabs** across the top, each showing its host, channel, runtime version and key id.
An environment with no `adminToken` shows up, but listing its releases fails with
`no admin token configured for <name>`.

**A release table** with release id, runtime, status, rollout, adoption, published date and notes,
filterable by runtime and platform. Clicking a row opens a drawer with the manifest facts, the
adoption breakdown, a rollout slider, and Pause, Resume and Roll back buttons.

**New release** builds and publishes. Pick platforms, set the rollout percentage, mark it
mandatory, limit it to app versions, add notes. It runs the bundle step, seals and signs the
release, uploads only the blobs the server is missing, and streams the log while it works. A
`protected` environment defaults the slider to 10% instead of 100%. The bundle version is one
higher than the highest release on that channel and platform. Builds run in a fixed folder per
project, environment and platform (under your user cache directory), so an unchanged file
produces the same bytes and isn't uploaded again.

**Native policy** sets the force-update gate per channel. Store URLs must be `https://`, `market://` or `itms-apps://`.

Publishes are single-flight: one at a time across all environments, and a second attempt gets a
409 rather than racing.

## How it stays safe

The process reads your signing key and admin tokens, so it is built to be unreachable from
anywhere but your own machine:

- **Binds `127.0.0.1` only.** Not `0.0.0.0`. Nothing on your network can reach it.
- **Rejects foreign `Host` headers**, which blocks DNS rebinding.
- **Requires a session token**, 24 random bytes minted per launch, compared in constant time. It
  travels in the URL *fragment*, which browsers never send to a server, so it can't end up in a
  request log. The page moves it into `sessionStorage` and removes it from the address bar.
- **Strict CSP**: scripts run only with a per-response nonce, and `frame-ancestors 'none'` stops
  it being embedded. Values that come from your backend, such as adoption counts, are rendered as
  text, never as HTML.
- **Never serves your secrets.** The environment listing returns only the host, channel, app id,
  runtime version, key id, platforms, and whether a key is present. Admin tokens, passphrases and
  key material stay in the process.

Because the token is per launch, restarting the dashboard invalidates the old link. Sharing the
URL with someone on another machine doesn't work: the port isn't listening for them.

## What it cannot do

The CLI remains the complete interface. The dashboard deliberately does not expose:

- `--no-encrypt`: dashboard publishes are always encrypted
- `--allow-insecure`: plain `http://` to a remote host is refused, with no override
- an explicit `--bundle-version`: it always uses the next one
- `--bundle-id`, `--compression-level`
- `fingerprint`: see the warning above

It keeps the logs of the last 20 publishes in memory; older ones are dropped.

## Should you use this or the CLI?

Use the dashboard when you want to see what's out there, how adoption looks, and whether to ramp. Use the CLI in CI, where flags and exit codes are what you want. They talk to the same
backend through the same code, so mixing them is fine.

→ [CLI commands](/docs/cli/commands) · [Staged rollouts](/docs/guides/staged-rollout) ·
[CI/CD](/docs/cli/ci-cd)
