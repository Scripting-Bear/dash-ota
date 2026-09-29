# dash-ota

A self-hosted, **signed over-the-air (OTA) update system for React Native**: you own the client,
the release tooling and the backend. It was built to replace a managed OTA SDK (Stallion /
CodePush) in a financial app.

The most important property: **bundle integrity is verified in native against Ed25519 public keys
compiled into the app binary**, and **signing happens only in the CLI**, so even a fully breached
backend cannot forge or modify an update. Signing is mandatory; there is no unsigned mode.

---

## Documentation

Full documentation, including a step-by-step first update: **https://scripting-bear.github.io/dash-ota**

| | |
|---|---|
| [If you've never shipped an OTA update](https://scripting-bear.github.io/dash-ota/docs/getting-started/what-is-an-ota-update) | start here if the idea is new |
| [Ship your first update](https://scripting-bear.github.io/dash-ota/docs/getting-started/quickstart) | backend, keys, app wiring, publish, roll back |
| [If your server is breached](https://scripting-bear.github.io/dash-ota/docs/security/breach) | what an attacker with root can and cannot do |
| [The local dashboard](https://scripting-bear.github.io/dash-ota/docs/cli/dashboard) | a web console that runs on your machine |
| [Wire protocol](./docs/PROTOCOL.md) · [Design & threat model](./DESIGN.md) | the specs |

---

## What's in the box

Four packages over one shared core (npm workspaces monorepo):

| Package | Role |
|---|---|
| **`packages/rn`** → `react-native-dash-ota` | Client library: one `<DashOtaProvider>` + `useOtaUpdate()` over native Android (Kotlin + Tink) / iOS (Swift CryptoKit). TurboModule (New Arch). Verifies + decrypts in native, applies on next cold start, rolls back on crash. |
| **`packages/cli`** → `@dash-ota/cli` | Release tooling; the binary is `dash-ota` (`npx @dash-ota/cli …`, or `npx dash-ota …` once `@dash-ota/cli` is installed in your project). Bundles, encrypts, **signs** with your Ed25519 private key (keep it in CI or a KMS), publishes, operates rollouts. |
| **`packages/backend`** → `@dash-ota/backend` | Config-driven, plug-and-play distributor. One `dashOtaMiddleware()` into any Express/Connect app, or standalone. Serves **pre-signed** manifests + ciphertext; **never holds the signing key**. |
| **`packages/shared`** → `@dash-ota/shared` | Crypto/protocol core (Ed25519, AES-256-GCM, ECDSA device-key auth, canonical JSON, manifest schema). Crypto from Node's built-in `crypto`; zstd from `@mongodb-js/zstd`. |

---

## Security model

- **Integrity** — every manifest is **Ed25519-signed in the CLI** and **verified in native** with
  public keys embedded in the binary. Holds even if TLS is broken.
- **Confidentiality** — blobs are **AES-256-GCM** ciphertext, which protects the blob store. The
  content key travels in the manifest, so the server, every enrolled install and an active MITM on
  `/check` can read bundles. Optional native TLS pinning covers blob downloads only.
- **Anti-replay & enrollment** — each install holds a **device key** (AndroidKeyStore / Secure
  Enclave, with a software fallback on iOS by default); enrollment registers only the **public**
  key, and requests are signed with **ECDSA P-256** + nonce + timestamp. No symmetric secret is
  transmitted. Who may enroll is decided by your `verifyEnrollToken` hook; the default only checks
  that a token is present.
- **Targeting** — exact `runtimeVersion` (native-compat key) + optional `targetAppVersions` +
  `channel` + staged `rollout %`. An OTA only installs on a binary with the same `runtimeVersion`.
- **Reliability** — apply on the next cold start, crash-loop circuit breaker (revert to
  last-known-good, and from 0.5.1 to the embedded bundle if that also loops), a downgrade guard
  that refuses anything not newer than the running bundle, and server-side auto-pause.

What a breached server can still do (withhold updates, re-serve older signed releases, force a hard
update prompt, read bundles) is listed in
[If your server is breached](https://scripting-bear.github.io/dash-ota/docs/security/breach).

Full threat model and rationale: **[DESIGN.md](./DESIGN.md)**.

---

## Quick start (local)

```bash
npm install
npm run test:core     # crypto/protocol self-test (no server)
npm run test:e2e      # publish → check → download → verify+decrypt, incl. attack cases
npm run test:express  # the distributor mounted inside a real Express app
npm run build         # build the npx-executable CLI

npm run backend       # standalone distributor on :4455
npx dash-ota keygen --key-id key_dev_1
```

Then follow the [CLI guide](./docs/cli.md) to publish, and the
[React Native guide](./docs/react-native.md) to wire a client.

---

## Repository layout

```
packages/
  rn/        react-native-dash-ota   (client: JS + native Android/iOS + example app)
  cli/       @dash-ota/cli           (signing + release tooling)
  backend/   @dash-ota/backend       (distributor: Express middleware + standalone)
  shared/    @dash-ota/shared        (crypto/protocol core)
docs/        integration guides (backend, react-native, cli)
DESIGN.md       design & threat model
```

> Keep Ed25519 **private** signing keys in CI secrets or a KMS, never in the repo (`.keys/` and
> `*.private.pem` are gitignored here).
