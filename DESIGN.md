# dash-ota — Proof of Concept

A custom, self-hosted, security-hardened **over-the-air (OTA) JavaScript-bundle update system
for React Native**, built to replace a managed OTA SDK (Stallion / CodePush) with **full
ownership** of the client, the release tooling, and the backend.

> **Status:** POC complete and **validated end-to-end on both platforms** — Android (emulator)
> and iOS (simulator) — on React Native **0.79**, **New Architecture (Fabric + TurboModules)**,
> **Hermes**. All automated suites green; the security guarantees were validated on simulators/
> emulators and in automated suites (not field-tested on physical retail hardware at scale).
> The three deliverables ship as **config-driven, plug-and-play libraries**: a backend that
> drops into any Express/Connect app as one middleware, an `npx`-executable CLI, and a
> single-provider React Native client.

---

## 1. Why this exists (the brief)

A financial-grade trading app needs to ship JS fixes without an app-store round-trip, but a
managed OTA SDK means trusting a third party with the keys to push code to production. The
goal was to **own everything** while meeting a hard security bar:

| Requirement (from the brief) | How it's met |
|---|---|
| Error & fallback mechanism | Fail-closed everywhere; native crash-loop auto-revert to last-known-good; embedded-bundle fallback |
| Bundle integrity (anti-MITM / anti-injection) | **Ed25519 code-signing**, verified in native against a key baked into the binary |
| Secure retrieval (anti-sniffing) | TLS; **AES-256-GCM** per blob protects the blob store (the key travels in the manifest — see §3) |
| Anti-replay / anti-session-replay | Per-install **device-key signature (ECDSA P-256)** + client nonce + timestamp; server-issued nonce binds `/confirm` to a real `/check` |
| Enrollment bootstrap (no secret to intercept) | **Device key** generated in the AndroidKeyStore / Secure Enclave (iOS falls back to a software key by default); only the **public** key is transmitted. Who may enroll is decided by the host's `verifyEnrollToken`; the default only checks that a token is present |
| Support all supported versions + modern arch | New Arch + Hermes; native crypto via OS/maintained libs |
| Self-hosted backend | Node/TS distributor we run |
| Don't disclose too much at frontend; **no S3 URL**; API-only | Manifest from our API; bytes streamed via a **short-lived download token** scoped to one release |
| Per-environment build flavours (dev / uat / prod) | Per-flavour channel **+ its own signing key** + runtimeVersion |

---

## 2. Architecture

Three independently-owned packages + a shared core (monorepo, decoupled from the app):

```
   ┌─ dash-ota-cli  (CI / release machine — HOLDS the Ed25519 PRIVATE KEY) ─┐
   │  bundle → hermesc (HBC) → AES-256-GCM encrypt → SIGN manifest → upload   │
   └──────────────────────────────┬───────────────────────────────────────────┘
                                   │  POST /admin/releases  (pre-signed manifest, then blobs)
                                   ▼
                            OUR API  (TLS; optional native pinning on blob downloads)
   ┌─────────────┐  POST /ota/v2/check   ┌──────────────────────────────┐
   │  RN app     │ ── device-key sig ───▶ │  dash-ota-backend (Node)   │
   │ (uses the   │ ◀── signed manifest ── │  - verifies ECDSA/nonce/ts   │
   │  RN pkg)    │    (Ed25519 + AESkey)  │  - targeting + rollout match │
   │  JS+native  │  GET  /ota/v2/…/blobs/:sha  │  - serves PRE-SIGNED data     │
   │             │ ──── download token ──▶ │  - NEVER holds the signing key│
   │             │ ◀── AES-GCM bytes ───── └──────────────────────────────┘
   └──────┬──────┘
          │ stageBundle(...)            ← RN package, native side
          ▼
   ┌──── react-native-dash-ota · native (Kotlin / Swift) ──────────────────────┐
   │ verify Ed25519 sig (embedded pubkey) → AES-256-GCM decrypt → per-file SHA-256 │
   │ → unpack → atomic slot stage → apply on next cold start → crash-loop rollback │
   │ getBundleFile()/getBundleURL()  ·  markHealthy()  ·  rollback()               │
   └──────────────────────────────────────────────────────────────────────────────┘
```

**Packages**

| Package | Role |
|---|---|
| **`packages/rn`** — `react-native-dash-ota` | The client library: a single `<DashOtaProvider config={…}>` + `useOtaUpdate()` hook over native **Android (Kotlin + Google Tink)** and **iOS (Obj-C++ TurboModule + Swift CryptoKit)**. TurboModule (New Arch). Fully config-driven (see §13). |
| **`packages/cli`** — `@dash-ota/cli` | Release tooling, **`npx`-executable** (bundled to a single self-contained file). **Holds the Ed25519 private key** (CI/release only). keygen, fingerprint, bundle, publish, rollout/pause/rollback, native-policy. |
| **`packages/backend`** — `@dash-ota/backend` | A *dumb, compromise-tolerant* distributor, shipped as a **plug-and-play library**: mount it into any Express/Connect app with one `dashOtaMiddleware(config)`, or run it standalone. Config-driven hooks for auth/analytics/logging/storage. Stores + serves **pre-signed** manifests + ciphertext; **never holds the signing key.** |
| **`packages/shared`** | Internal crypto/protocol core (Ed25519, AES-GCM, canonical JSON, manifest schema, targeting, ECDSA request verification). Pure Node `crypto` — no external crypto deps. |

**Division of trust** (the core idea):
- **Networking + orchestration** run in **JS** (easy to iterate). The JSON calls use JS `fetch`, pinned only if the host passes a pinned `fetch` as `transport`; blob downloads run in native.
- **Trust-critical steps** — signature verify, decrypt, per-file hash, file swap, rollback — run in **native**, independent of JS, and the bundle to boot is chosen before JS starts, so a compromised JS bundle can't bypass them.
- **Signing** happens **only in the CLI/CI**. A compromised backend, a broken TLS channel, or a tampered JS bundle each independently fail to forge or apply an update.

---

## 3. Security model (threat → control)

| Threat | Control | Enforced where |
|---|---|---|
| MITM / tampered bundle / injection | **Ed25519 signature** on the manifest, public key **embedded in the binary** | Sign: CLI/CI · Verify: **native** |
| Reading the blob store | **AES-256-GCM** ciphertext per blob, **authenticated** (the GCM tag detects any tampering of the bytes); the content key travels inside the signed manifest, not beside the blobs | Native decrypt |
| Replay of update requests | Per-install **device-key signature (ECDSA P-256)** over a canonical request string + client nonce + timestamp; a **server-issued nonce** on `/check` is echoed on `/confirm` | Backend + native device-key signing |
| Enrollment interception (no shared secret) | Device generates its key pair; only the **public** key is enrolled, and the host's `verifyEnrollToken` decides who may enroll. There is no symmetric secret to sniff or replay. | Native keystore + backend `verifyEnrollToken` |
| Cross-environment leakage | Signed `channel` checked natively against the binary's (client 0.5.1 and later), optional per-env signing keys, channel routing | Native verify + backend filter |
| Serving a malicious bundle from a breached backend | Backend never holds the signing key → can't forge a valid signature | Architecture |
| Older bundle replayed | `bundleVersion` must exceed the running bundle's. Nothing is persisted, so after a store update, `rollback()` or crash-loop revert an older signed release can install again | Native |
| Crash-looping bundle bricking the app | **Crash-loop circuit breaker** → revert to last-known-good (then embedded, 0.5.1 and later), **disable** the bundle, report to backend | Native + provider |
| Forged TLS cert | Certificate **pinning** on native blob downloads, off by default; JS requests only through a pinned `fetch` the host passes as `transport` | `ota_tls_pins` / `OTA_TLS_PINS`, `transport` |
| Cloned / modified app | Play Integrity / App Attest token attached at enrollment, off by default; not bound to a server challenge | `IntegrityAttestor` + `verifyEnrollToken` |
| Hostile force-update policy | The client ignores the server's `storeUrl` and uses the app's own (client 0.5.0 and later). **Not covered:** `nativePolicy` is unsigned, so a breached server can send `severity: "hard"` | Provider |

> **Honest note on confidentiality:** Ed25519 gives **integrity even if TLS is fully broken**.
> AES-256-GCM does much less: the content key is in the manifest, which `/check` returns to any
> enrolled install for the channel it asks about. It keeps blobs unreadable to someone who can read
> the blob store but not the manifests. It does not hide bundles from the backend operator, an
> enrolled install, an active MITM on `/check` (a JS request, unpinned unless the host pins it), or
> anyone with access to device storage, where files are kept decrypted.

---

## 4. Key design decisions

1. **Sign in the CLI/CI, not the backend.** The backend stores and serves pre-signed data and
   never possesses the private key (expo-updates' code-signing model). A breached backend
   cannot push a malicious update.
2. **Trust-critical work in native.** Verify/decrypt/hash/swap run in Kotlin/Swift, outside JS,
   so a compromised bundle can't disable its own verification.
3. **JS computes the canonical manifest bytes; native verifies the Ed25519 signature over those
   exact bytes against the embedded public key.** This avoids reimplementing byte-exact
   canonical-JSON in Kotlin *and* Swift (a classic source of signature mismatches) while keeping
   the integrity decision in native. It is **not** a trust hole: JS only *formats* the bytes —
   if a compromised bundle passes tampered manifest bytes, the signature simply won't verify
   against the embedded key and native fails closed. Native parses the same bytes it verified.
   JS cannot mint or alter a signature; the private key never leaves the signer. (The canonicalization is the deterministic JSON the CLI signed;
   native treats the JS-provided bytes as untrusted input to a native signature check.)
4. **runtimeVersion gate** solves the *store-vs-OTA* problem: a JS-only OTA built for a new
   native binary must never land on an older one. Enforced on the backend *and* in native.
5. **API-only delivery, no S3 URL on the frontend.** `/check` returns a manifest with a
   **short-TTL download token** (30 minutes by default) scoped to that release and sent in a
   header; bytes are fetched from our own API.
6. **Device identity, no transmitted secret.** Each install holds an EC P-256 key in the
   **AndroidKeyStore / iOS Secure Enclave** (iOS falls back to a software Keychain key unless
   `OTA_REQUIRE_HARDWARE_KEY` is set); enrollment registers only the **public** key, gated by the
   host's `verifyEnrollToken`. Requests are signed with the private key (ECDSA-P256), so there is
   no symmetric secret that an active MITM at enroll could capture, with or without pinning.
7. **Established native crypto, not hand-rolled:** **Google Tink** (Ed25519) on Android, Apple
   **CryptoKit** (Curve25519 + AES.GCM) on iOS; JDK + `SecKey`/`Security.framework` for
   AES-GCM / SHA-256 / device-key ECDSA.
8. **Apply on next cold start**, or on an explicit `applyUpdate(true)` (an in-process reload on
   iOS, a process relaunch on Android), + **crash-rollback**.

---

## 5. OTA lifecycle

```
enroll (once) ──▶ check ──▶ [eligible?] ──▶ download (token) ──▶ NATIVE: verify sig
                                                                  → decrypt → per-file hash
                                                                  → stage to slot
                                                                        │
                          apply on next cold start ◀── applyOnNextLaunch┘
                                    │
                          app boots usable ──▶ markHealthy ──▶ confirm(healthy) to backend
                                    │
                  (2 charged cold starts) ──▶ circuit breaker: revert to last-known-good,
                                            disable the bad bundle, confirm(failed)
```

**On-disk slot model** (per platform, in app storage): `current`, `lastKnownGood`, `staged`,
`pending`, plus boot-attempt counters and a `disabledBundles` list. State writes go to a temp
file that is renamed over the old one; GC runs at launch and keeps every slot the state references
(`current`, `lastKnownGood`, `pending`, `staged`).

**Backend endpoints:** `POST /ota/v2/enroll`, `POST /ota/v2/check`,
`GET /ota/v2/releases/{id}/blobs/{sha}`, `POST /ota/v2/confirm`, the three-step publish
(`POST /admin/releases` → `PUT …/blobs/{sha}` → `POST …/finalize`), `POST /admin/keys`, plus
`rollout`/`pause`/`rollback`/`native-policy`/`releases`.

---

## 6. Versioning & targeting

Two identifiers travel with every binary **and** every OTA:

- **`runtimeVersion`** — the *native-compatibility key* (changes only when native code/deps/
  Hermes change). Baked into the binary; stamped onto every OTA. Exact-match required.
- **`bundleVersion`** — increasing counter per runtimeVersion; a device only installs a release
  whose `bundleVersion` exceeds the bundle it is running.

Plus optional axes: **`channel`** (dev/uat/prod), **`targetAppVersions`** (semver range over
the marketing/build version), and **`rollout %`** (deterministic per-install bucketing).

**Matching rule** (`/check`): same `channel` & `platform`, **exact `runtimeVersion`**,
`appVersion ∈ targetAppVersions`, `buildNumber ≥ minNativeBuild`, within the rollout bucket,
`bundleVersion > current`, not paused or rolled back → newest wins, else "no update." The backend
enforces all of it (won't offer). Native (won't apply) re-checks `appId`, `runtimeVersion` and
`bundleVersion`, and from client 0.5.1 also `channel`, `platform` and `minNativeBuild`; targeting
ranges, rollout and pause state are server-side only.

---

## 7. Feature list (what's built)

**Security & integrity**
- Ed25519 manifest signing (CLI) + native verification (embedded public key, key-ring ready)
- AES-256-GCM authenticated blob encryption (protects the blob store; see §3)
- **Device key** (AndroidKeyStore / Secure Enclave, iOS software fallback by default); enrollment
  transmits only the public key, gated by the host's `verifyEnrollToken`
- Per-install **device-key ECDSA** request signing + nonce + timestamp (anti-replay)
- Per-environment signing keys (optional) plus a native channel check (client 0.5.1 and later)
- One content-addressed blob per distinct file, each with **its own SHA-256** for the stored bytes
  and for the plaintext (bundle + every asset), so a device fetches only what it lacks
- Fail-closed on every error

**Reliability**
- Atomic apply on next cold start
- **Crash-loop circuit breaker**: revert to last-known-good (and, from 0.5.1, to embedded if that
  also loops); **disable** the bad bundle so it isn't re-downloaded; report the failure to the
  backend (drives auto-pause)
- `markHealthy` confirmation + adoption telemetry

**Release control**
- Channel routing (dev/uat/prod) + runtimeVersion gate + targetAppVersions + rollout %
- Pause / rollback / staged rollout; server-side **auto-pause** on failure-rate spikes
- **Force-update policy** (`soft` / `hard`) for the host app to render as a nudge or a blocking
  "update from store" screen (unsigned — see §3)
- Update modes: **auto** (silent, apply next launch), **manual** (`checkNow`/`applyUpdate`),
  **mandatory**
- Release notes → in-app "What's New"

**Tooling (CLI)**
- `keygen`, `register-key`, `fingerprint` (runtimeVersion), `bundle` (+ Hermes HBC), `publish`
  (interactive release notes), `list`, `rollout`, `pause`, `rollback`, `native-policy`,
  `dashboard`

**Extensibility (config-driven)**
- **Backend** hooks: `verifyEnrollToken` (your auth), `onConfirm`/`onPublish` (analytics),
  `logger`, and a bring-your-own `store` — all optional, all passed through config.
- **RN** client: a single injected `OtaConfig` drives every capability (storage adapter,
  `autoCheckOnLaunch`, `autoStage`, `autoMarkHealthyMs`, `checkOnAppForeground`, `onStatusChange`,
  `getEnrollToken`, `storeUrl`, `logger`).
- `transport` (a `TransportSecurity` whose `fetch` can pin the JSON calls) and `attestor` (an
  `IntegrityAttestor` for Play Integrity / App Attest) — both optional and unset by default; the
  core depends only on the interfaces.

---

## 8. Plug-and-play & configuration (per package)

Everything is **config-driven** — you supply a config object and the capabilities turn on; no
forking the core.

**Backend — one middleware into your Express/Connect app:**

```ts
import express from 'express';
import { dashOtaMiddleware, rawBodySaver } from '@dash-ota/backend';

const app = express();
// keep raw bytes for the request signature; raise the 100 kB default so release manifests fit
app.use(express.json({ limit: '5mb', verify: rawBodySaver }));
app.use(dashOtaMiddleware({
  adminToken: process.env.OTA_ADMIN_TOKEN,
  verifyEnrollToken: (token) => myAuth.verifySession(token),   // your auth
  onConfirm: (e) => metrics.track(e),                          // your analytics
  logger: console,
  // storageDir / dataDir / timestampSkewMs / autoPause… all optional with safe defaults
}));
app.listen(4455);
```

The OTA routes are absolute (`/ota/v2/*`, `/admin/*`, `/health`, `/ready`); anything the middleware
doesn't own falls through to `next()`, so it coexists with your app. The same route core also
runs **standalone** (`createOtaBackend(config).listen()` or the built-in `node:http` server) and
is fully framework-agnostic, so a future Fastify/Koa adapter is a thin wrapper. The request
signature is over the **raw** body bytes — mount before a body parser, or stash them with the
exported `rawBodySaver`.

**CLI — `npx`-executable, zero global install:**

```bash
npx @dash-ota/cli keygen --key-id key_prod_1
npx @dash-ota/cli publish --bundle-dir ./out --app-id com.example.app --platform android \
    --channel prod --runtime-version auto --bundle-version 7 --rollout 10
```

It bundles to a single file with no `tsx` dependency; its one native dependency is
`@mongodb-js/zstd`. It needs Node 20.19.0 or later — locally, in CI, or via `npx`.

**React Native — one provider, all capabilities via config:**

```tsx
<DashOtaProvider config={{
  appVersion: '1.4.0',
  storage,                         // your AsyncStorage / secure-storage adapter
  getEnrollToken: () => auth.getSessionToken(),
  autoCheckOnLaunch: true,
  checkOnAppForeground: true,
  autoMarkHealthyMs: 4000,         // or omit and call markHealthy() from your first screen
  onStatusChange: (s) => log(s),
}}>
  <App />
</DashOtaProvider>
```

Channel, runtimeVersion and the embedded public keys come from the **native** side (per build
flavour), so JS cannot change them. The server URL comes from native too; `serverUrlOverride`
exists for tests and local development.

---

## 9. Build flavours (dev / uat / prod) — the go-trade approach

Each flavour embeds its **own channel + its own signing public key + runtimeVersion**, so an
OTA can only reach the matching flavour, and only if signed by that environment's key.

- **Android** — `example/.env.{dev,uat,prod}` → injected as per-flavor `resValue` string
  resources in `android/app/build.gradle`; the native `DashOtaConfig` reads them by name.
  Product flavors give distinct `applicationId`s so all three coexist on one device.
- **iOS** — `example/ios/Config/App.{Dev,UAT,Prod}.xcconfig` → `Info.plist $(OTA_*)`
  substitution → read by `DashOtaConfig` (Swift). (Full Xcode `Debug/Release-{Dev,UAT,Prod}`
  configs + schemes are the IDE/CI productionization step, mirroring go-trade.)

---

## 10. What was verified (evidence)

**Automated:** `npm run test:core` (Ed25519 / AES-GCM / canonical-JSON / targeting /
fingerprint, incl. tamper & forgery). `npm run test:e2e` (publish → check → download →
verify+decrypt, plus runtimeVersion gate, replay, download-token scope, force-update, auto-pause)
over the **asymmetric device-key (ECDSA P-256)** request auth, including forged-signature and
replay rejection. `npm run test:express` (the distributor mounted inside a real Express app behind
a global body parser: raw-byte signature verification, `verifyEnrollToken` gate, and the
`onConfirm` hook). All four TypeScript packages typecheck clean.

> The on-device matrix below was first captured on the earlier symmetric-secret build; the
> request-auth layer has since moved to the **device key (ECDSA P-256)**, which is covered by the
> asymmetric e2e + Express suites above. The remaining on-device step is re-confirming the native
> **AndroidKeyStore / Secure Enclave** key round-trips against the live backend (enroll with the
> device public key → signed `/check` accepted → forged request rejected).

**On-device matrix**

| Scenario | Android | iOS | Result |
|---|---|---|---|
| Full OTA loop (enroll → check → native verify/decrypt → stage → apply → new JS runs) | ✅ | ✅ | bundle v1 applied |
| **Wrong-key rejection** (backend serves attacker-signed bundle) | ✅ | — | "signature did not verify", stays on good bundle |
| **Crash-loop** (crashing bundle) | ✅ | — | reverts to last-known-good, disables it, reports failed, self-heals |
| Rollout 0% + wrong-runtimeVersion exclusion | ✅ | — | not offered/applied |
| Force-update **hard** gate | ✅ | — | blocking "update from store" |
| `markHealthy` persistence + adoption | ✅ | ✅ | bundle persists; backend records healthy |
| **Per-flavour routing** (dev/uat/prod each gets only its channel) | ✅ all 3 | ✅ uat | adoption healthy=1 per channel, zero cross-talk |
| **Key isolation** (uat-channel bundle signed with dev's key) | ✅ | — | rejected by uat app |

Representative final release matrix on the backend:

```
android/dev  v1  healthy:1     ← dev app only
android/uat  v1  healthy:1     ← uat app only
android/prod v1  healthy:1     ← prod app only
android/uat  v2  healthy:0     ← WRONG-KEY bundle: NEVER applied (rejected)
ios/uat      v1  healthy:1     ← iOS uat app only
ios/dev      v1  healthy:0     ← untouched by the uat app
```

---

## 11. Tech & platform

- **React Native 0.79**, **New Architecture** (Fabric + TurboModules), **Hermes** (OTA bundles
  compiled to HBC with the binary's own `hermesc`).
- **Android:** Kotlin TurboModule; **Google Tink** (Ed25519) + JDK (AES-256-GCM / SHA-256);
  device key in the **AndroidKeyStore** (EC P-256, `SHA256withECDSA`); config via `resValue`
  string resources; `getJSBundleFile()` hook.
- **iOS:** Obj-C++ TurboModule + Swift **CryptoKit** (Curve25519 + AES.GCM + SHA256); device key
  in the **Secure Enclave**, or a software Keychain key as fallback, via `Security.framework` (`SecKey`, EC P-256, exported as
  SPKI-DER; `ecdsaSignatureMessageX962SHA256`); config via Info.plist; `bundleURL()` hook.
  (Static-lib pod → Swift header via `__has_include` guard.)
- **Backend / CLI / shared:** Node 20.19.0+ and TypeScript; crypto from `node:crypto` (no
  external crypto deps), zstd from `@mongodb-js/zstd`. The repo scripts run the sources via `tsx`;
  the published packages are built.

---

## 12. How to run

```bash
# from the dash-ota repo root
npm install
npm run test:core                  # crypto/protocol self-test (14 checks)
npm run test:e2e                   # node:http distributor e2e (10 checks)
npm run test:express               # Express-adapter smoke test (7 checks)

npm run backend                    # standalone distributor on :4455
npm run backend:express            # the same routes mounted in an Express app

# CLI — runnable via npx (after `npm run build`, or once published):
npx dash-ota keygen --key-id key_dev_1
npx dash-ota register-key --key-id key_dev_1 --key-file .keys/key_dev_1.public.json

# publish an OTA to a channel (auto-signs with that channel's key, compiles HBC)
node packages/rn/example/scripts/publish-ota.mjs \
  --platform android --channel dev --bundle-version 2 --runtime-version rt1 \
  --release-note "what changed"

# run the example app (release build loads OTA; debug uses Metro)
cd packages/rn/example/android && ./gradlew :app:assembleDevRelease   # Android
# iOS: pod install, then xcodebuild Release with OTA_* overrides (see README)
```

---

## 13. Not built yet

Since the POC, TLS pinning (native, blob downloads) and the attestation hook have shipped, both off
by default, along with a local web dashboard over the admin API and Postgres, SQLite, Redis and S3
providers for the backend. Still missing:

- **A signed force-update policy.** `nativePolicy` is unsigned, so a breached server can send
  `severity: "hard"`.
- **A persisted downgrade floor.** The guard compares against the running bundle only.
- **Remote signing-key revocation.** A leaked key stays trusted until a store build drops it.
- **Pinning for the JSON calls out of the box.** Hosts must supply a pinned `fetch` as `transport`.
- **Differential (bytecode) patches.** The manifest reserves `patches`; nothing generates them.
- **CDN delivery.** Every blob streams through the backend.
- **Runtime channel switching.** The channel is fixed at build time.
- **iOS download progress and resumable iOS downloads.** Android has both.
- **Source-map upload from `publish`**, and **iOS Xcode `Debug/Release-{Dev,UAT,Prod}` scheme
  generation** (the xcconfig pattern works; schemes are written by hand).
- **Key custody tooling.** Keep *signing* keys in **CI secrets / KMS / HSM**, never on a laptop;
  rotation works through a transition build that embeds old and new keys. **Device keys** rotate
  for free: re-enrolling overwrites the stored public key per install.

The maintained list is the documentation site's roadmap page.

---

## 14. Honest limitations

- Confidentiality is limited: the content key reaches every enrolled install and anyone who can
  read `/check`, and devices store decrypted files. Integrity does not depend on it.
- A breached backend cannot forge a release, but it can withhold updates, re-serve older or
  withdrawn signed releases (after a store update, `rollback()` or crash-loop revert, or to devices
  below them), send a `hard` force-update policy, and read bundles.
- The default disk store is single-node (data persists to JSON files); use the Postgres/SQLite,
  Redis and S3 providers for anything shared or highly available.
- The example uses in-memory client storage (re-enrolls per cold start). Re-enroll is cheap and
  idempotent (it re-registers the same public key), but a real app should inject AsyncStorage or
  secure storage via the same `OtaStorage` interface to keep a stable `installId`.
- iOS multi-flavour was validated via `xcodebuild` build-setting overrides; the IDE scheme setup
  is pending.
- The device key uses the **Secure Enclave on hardware**. On the iOS **Simulator** (no Enclave), and
  on a device where Secure Enclave key creation fails unless `OTA_REQUIRE_HARDWARE_KEY` is set, it
  falls back to a software Keychain key: functionally identical for the protocol, but without the
  hardware-isolation guarantee. `keyHardwareBacked` is reported by the device and cannot be
  verified by the backend.
