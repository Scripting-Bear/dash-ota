# dash-ota

A custom, self-hosted, **hardened over-the-air (OTA) update system for React Native** — full
ownership of the client, the release tooling, and the backend, built to replace a managed OTA
SDK (Stallion / CodePush) with a security model strong enough for a financial-grade app.

The single most important property: **bundle integrity is verified in native against an Ed25519
public key baked into the app binary**, and **signing happens only in the CLI** — so even a fully
breached backend cannot forge an update.

---

## 📚 Documentation

| Guide | What it covers |
|---|---|
| **[Backend integration](./docs/backend.md)** | Mount `@dash-ota/backend` into Express/Connect (or run standalone), config, hooks, endpoints |
| **[React Native integration](./docs/react-native.md)** | Install `react-native-dash-ota`, native per-flavour config, `<DashOtaProvider>` + `useOtaUpdate()` |
| **[CLI usage](./docs/cli.md)** | `dash-ota` commands: keygen → publish → rollout, per-env keys, key custody |
| **[Design & threat model (POC)](./POC.md)** | Full architecture, security model, versioning/targeting, lifecycle, evidence |

---

## What's in the box

Four packages over one shared core (npm workspaces monorepo):

| Package | Role |
|---|---|
| **`packages/rn`** → `react-native-dash-ota` | Client library: one `<DashOtaProvider>` + `useOtaUpdate()` over native Android (Kotlin + Tink) / iOS (Swift CryptoKit). TurboModule (New Arch). Verifies + decrypts in native, applies on next cold start, rolls back on crash. |
| **`packages/cli`** → `@dash-ota/cli` | Release tooling, **`npx dash-ota`**. Bundles, encrypts, **signs** (holds the Ed25519 private key, CI only), publishes, operates rollouts. |
| **`packages/backend`** → `@dash-ota/backend` | Config-driven, plug-and-play distributor. One `dashOtaMiddleware()` into any Express/Connect app, or standalone. Serves **pre-signed** manifests + ciphertext; **never holds the signing key**. |
| **`packages/shared`** → `@dash-ota/shared` | Crypto/protocol core (Ed25519, AES-256-GCM, ECDSA device-key auth, canonical JSON, manifest schema). Pure Node `crypto`. |

---

## Security model (v1)

- **Integrity** — every manifest is **Ed25519-signed in the CLI** and **verified in native** with
  a public key embedded in the binary. Holds even if TLS is broken.
- **Confidentiality** — bundle bytes are **AES-256-GCM** ciphertext (defense-in-depth; active-MITM
  confidentiality lands with the deferred TLS-pinning plug-in).
- **Anti-replay & enrollment** — each install holds a **hardware-backed device key** (AndroidKeyStore
  / Secure Enclave); enrollment registers only the **public** key (gated by an app session token),
  and requests are signed with **ECDSA P-256** + nonce + timestamp. No symmetric secret is ever
  transmitted, so there's nothing to intercept at bootstrap.
- **Targeting** — exact `runtimeVersion` (native-compat key) + optional `targetAppVersions` +
  `channel` + staged `rollout %`. An OTA can never land on an incompatible native build.
- **Reliability** — atomic apply on cold start, crash-loop circuit breaker (revert → last-known-good
  → embedded), monotonic downgrade guard, server-side auto-pause, fail-closed everywhere.

Full threat model and rationale: **[POC.md](./POC.md)**.

---

## Quick start (local POC)

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
POC.md       design & threat model
```

> The CLI's Ed25519 **private** signing keys live only in CI/KMS — never committed (`.keys/`,
> `*.private.pem` are gitignored).
