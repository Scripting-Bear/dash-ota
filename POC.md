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
| Secure retrieval (anti-sniffing) | TLS **+** **AES-256-GCM** authenticated payload encryption |
| Anti-replay / anti-session-replay | Per-install **hardware device-key signature (ECDSA P-256)** + client nonce + timestamp; server-issued nonce binds `/confirm` to a real `/check` |
| Enrollment bootstrap (no secret to intercept) | **Hardware-backed device key** (AndroidKeyStore / Secure Enclave); only the **public** key is ever transmitted, gated by an authenticated app session token |
| Support all supported versions + modern arch | New Arch + Hermes; native crypto via OS/maintained libs |
| Self-hosted backend | Node/TS distributor we run |
| Don't disclose too much at frontend; **no S3 URL**; API-only | Manifest from our API; bytes streamed via a **one-time download token** |
| Per-environment build flavours (dev / uat / prod) | Per-flavour channel **+ its own signing key** + runtimeVersion |

---

## 2. Architecture

Three independently-owned packages + a shared core (monorepo, decoupled from the app):

```
   ┌─ dash-ota-cli  (CI / release machine — HOLDS the Ed25519 PRIVATE KEY) ─┐
   │  bundle → hermesc (HBC) → AES-256-GCM encrypt → SIGN manifest → upload   │
   └──────────────────────────────┬───────────────────────────────────────────┘
                                   │  POST /admin/publish  (pre-signed manifest + ciphertext)
                                   ▼
                            OUR API  (TLS today; pinning is a later modular plug-in)
   ┌─────────────┐  POST /ota/v1/check   ┌──────────────────────────────┐
   │  RN app     │ ── device-key sig ───▶ │  dash-ota-backend (Node)   │
   │ (uses the   │ ◀── signed manifest ── │  - verifies ECDSA/nonce/ts   │
   │  RN pkg)    │    (Ed25519 + AESkey)  │  - targeting + rollout match │
   │  JS+native  │  GET /ota/v1/download  │  - serves PRE-SIGNED data     │
   │             │ ──── one-time token ──▶ │  - NEVER holds the signing key│
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
- **Networking + orchestration** run in **JS** (easy to iterate; TLS pinning plugs in here later).
- **Trust-critical steps** — signature verify, decrypt, per-file hash, file swap, rollback — run in **native**, *before* and *independent of* JS, so a compromised JS bundle can't bypass them.
- **Signing** happens **only in the CLI/CI**. A compromised backend, a broken TLS channel, or a tampered JS bundle each independently fail to forge or apply an update.

---

## 3. Security model (threat → control)

| Threat | Control | Enforced where |
|---|---|---|
| MITM / tampered bundle / injection | **Ed25519 signature** on the manifest, public key **embedded in the binary** | Sign: CLI/CI · Verify: **native** |
| Sniffing the payload | TLS **+** **AES-256-GCM** ciphertext, which is **authenticated** (the GCM tag detects any tampering of the bytes); content key travels inside the signed manifest | Native decrypt |
| Replay of update requests | Per-install **hardware device-key signature (ECDSA P-256)** over a canonical request string + client nonce + timestamp; a **server-issued nonce** on `/check` is echoed on `/confirm` | Backend + native device-key signing |
| Enrollment interception (no shared secret) | Device generates a **hardware-backed key pair**; only the **public** key is enrolled, gated by an authenticated app session token. There is no symmetric secret to sniff or replay. | Native keystore + backend `verifyEnrollToken` |
| Cross-environment leakage | **Per-env signing keys** (dev/uat/prod) + channel routing | Native verify + backend filter |
| Serving a malicious bundle from a breached backend | Backend never holds the signing key → can't forge a valid signature | Architecture |
| Bad/old bundle replayed | Monotonic **bundleVersion** downgrade guard | Native |
| Crash-looping bundle bricking the app | **Crash-loop circuit breaker** → revert to last-known-good, **disable** the bundle, report to backend | Native + provider |
| Forged TLS cert *(later)* | Cert/public-key **pinning** — modular plug-in interface, no-op in v1 | `TransportSecurity` |
| Cloned / modified app *(later)* | Play Integrity / App Attest — modular plug-in interface, no-op in v1 | `IntegrityAttestor` |

> **Honest note on confidentiality:** Ed25519 gives **integrity even if TLS is fully broken** —
> that's why we can defer pinning. But AES-256-GCM only protects against *passive* sniffing and
> at-rest exposure; against an *active* MITM (who can read `/check` and thus the content key),
> confidentiality is only closed by the deferred **pinning** plug-in. Integrity = guaranteed in
> v1; confidentiality = defense-in-depth in v1.

---

## 4. Key design decisions

1. **Sign in the CLI/CI, not the backend.** The backend stores and serves pre-signed data and
   never possesses the private key (expo-updates' code-signing model). A breached backend
   cannot push a malicious update.
2. **Trust-critical work in native.** Verify/decrypt/hash/swap run in Kotlin/Swift before JS,
   so a compromised bundle can't disable its own verification.
3. **JS computes the canonical manifest bytes; native verifies the Ed25519 signature over those
   exact bytes against the embedded public key.** This avoids reimplementing byte-exact
   canonical-JSON in Kotlin *and* Swift (a classic source of signature mismatches) while keeping
   the integrity decision in native. It is **not** a trust hole: JS only *formats* the bytes —
   if a compromised bundle passes tampered manifest bytes, the signature simply won't verify
   against the embedded key and native fails closed. JS cannot mint or alter a signature; the
   private key exists only in CI. (The canonicalization is the deterministic JSON the CLI signed;
   native treats the JS-provided bytes as untrusted input to a native signature check.)
4. **runtimeVersion gate** solves the *store-vs-OTA* problem: a JS-only OTA built for a new
   native binary must never land on an older one. Enforced on the backend *and* in native.
5. **API-only delivery, no S3 URL on the frontend.** `/check` returns a manifest with a
   **one-time, short-TTL download token**; bytes are fetched from our own API.
6. **Hardware-backed device identity, no transmitted secret.** Each install holds a non-exportable
   EC P-256 key in the **AndroidKeyStore / iOS Secure Enclave**; enrollment registers only the
   **public** key (gated by an app session token). Requests are signed with the private key
   (ECDSA-P256), so there is no symmetric secret that an active MITM at enroll could capture —
   this closes the enrollment-bootstrap gap without depending on the (deferred) pinning plug-in.
7. **Established native crypto, not hand-rolled:** **Google Tink** (Ed25519) on Android, Apple
   **CryptoKit** (Curve25519 + AES.GCM) on iOS; JDK + `SecKey`/`Security.framework` for
   AES-GCM / SHA-256 / device-key ECDSA.
8. **Apply on next cold start** (never hot-swap mid-session) + **crash-rollback** — safest for a
   trading app.

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
                    (if it crashes N×) ──▶ circuit breaker: revert to last-known-good,
                                            disable the bad bundle, confirm(failed)
```

**On-disk slot model** (per platform, in app storage): `current`, `lastKnownGood`, `staged`,
`pending`, plus boot-attempt counters and a `disabledBundles` list. State writes are
crash-safe (temp + atomic rename); GC keeps only `current` + `lastKnownGood`.

**Backend endpoints:** `POST /ota/v1/enroll`, `POST /ota/v1/check`, `GET /ota/v1/download`,
`POST /ota/v1/confirm`, `POST /admin/publish`, `POST /admin/keys`, plus
`rollout`/`pause`/`rollback`/`native-policy`/`releases`.

---

## 6. Versioning & targeting

Two identifiers travel with every binary **and** every OTA:

- **`runtimeVersion`** — the *native-compatibility key* (changes only when native code/deps/
  Hermes change). Baked into the binary; stamped onto every OTA. Exact-match required.
- **`bundleVersion`** — monotonic counter per runtimeVersion (downgrade guard).

Plus optional axes: **`channel`** (dev/uat/prod), **`targetAppVersions`** (semver range over
the marketing/build version), and **`rollout %`** (deterministic per-install bucketing).

**Matching rule** (`/check`): same `channel` & `platform`, **exact `runtimeVersion`**,
`appVersion ∈ targetAppVersions`, within the rollout bucket, `bundleVersion > current`, not
paused → newest wins, else "no update." Enforced **on the backend** (won't offer) **and in
native** (won't apply).

---

## 7. Feature list (what's built)

**Security & integrity**
- Ed25519 manifest signing (CLI) + native verification (embedded public key, key-ring ready)
- AES-256-GCM authenticated payload encryption
- **Hardware-backed device key** (AndroidKeyStore / Secure Enclave); enrollment transmits only
  the public key, gated by an authenticated session token (`verifyEnrollToken`)
- Per-install **device-key ECDSA** request signing + nonce + timestamp (anti-replay)
- Per-environment signing keys (dev/uat/prod isolation)
- SOA1 payload archive with **per-file SHA-256** (bundle + every asset)
- Fail-closed on every error

**Reliability**
- Atomic apply on next cold start
- **Crash-loop circuit breaker**: revert to last-known-good → embedded; **disable** the bad
  bundle so it isn't re-downloaded; report the failure to the backend (drives auto-pause)
- `markHealthy` confirmation + adoption telemetry

**Release control**
- Channel routing (dev/uat/prod) + runtimeVersion gate + targetAppVersions + rollout %
- Pause / rollback / staged rollout; server-side **auto-pause** on failure-rate spikes
- **Force-update gate** (`soft` nudge / `hard` blocking "update from store")
- Update modes: **auto** (silent, apply next launch), **manual** (`checkNow`/`applyUpdate`),
  **mandatory**
- Release notes → in-app "What's New"

**Tooling (CLI)**
- `keygen`, `fingerprint` (runtimeVersion), `bundle` (+ Hermes HBC), `publish` (interactive
  release notes; per-channel auto-signing), `list`, `rollout`, `pause`, `rollback`,
  `native-policy`

**Extensibility (config-driven; modular interfaces, no-op in v1)**
- **Backend** hooks: `verifyEnrollToken` (your auth), `onConfirm`/`onPublish` (analytics),
  `logger`, and a bring-your-own `store` — all optional, all passed through config.
- **RN** client: a single injected `OtaConfig` drives every capability (storage adapter,
  `autoCheckOnLaunch`, `autoStage`, `autoMarkHealthyMs`, `checkOnAppForeground`, `onStatusChange`,
  `getEnrollToken`, `logger`).
- `TransportSecurity` (TLS pinning) · `IntegrityAttestor` (Play Integrity / App Attest) — the
  core depends only on the interfaces, so these drop in later without touching it.

---

## 8. Plug-and-play & configuration (per package)

Everything is **config-driven** — you supply a config object and the capabilities turn on; no
forking the core.

**Backend — one middleware into your Express/Connect app:**

```ts
import express from 'express';
import { dashOtaMiddleware, rawBodySaver } from '@dash-ota/backend';

const app = express();
app.use(express.json({ verify: rawBodySaver }));   // keep raw bytes for the request signature
app.use(dashOtaMiddleware({
  adminToken: process.env.OTA_ADMIN_TOKEN,
  verifyEnrollToken: (token) => myAuth.verifySession(token),   // your auth
  onConfirm: (e) => metrics.track(e),                          // your analytics
  logger: console,
  // storageDir / dataDir / timestampSkewMs / autoPause… all optional with safe defaults
}));
app.listen(4455);
```

The OTA routes are absolute (`/ota/v1/*`, `/admin/*`, `/health`); anything the middleware
doesn't own falls through to `next()`, so it coexists with your app. The same route core also
runs **standalone** (`createOtaBackend(config).listen()` or the built-in `node:http` server) and
is fully framework-agnostic, so a future Fastify/Koa adapter is a thin wrapper. The request
signature is over the **raw** body bytes — mount before a body parser, or stash them with the
exported `rawBodySaver`.

**CLI — `npx`-executable, zero global install:**

```bash
npx @dash-ota/cli keygen --key-id key_prod_1
npx @dash-ota/cli publish --bundle-dir ./out --platform android --channel prod \
    --runtime-version auto --bundle-version 7 --rollout 10
```

It bundles to a single self-contained file (no `tsx`/runtime deps), so it runs anywhere Node 18+
is present — locally, in CI, or via `npx`.

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

Channel, server URL, runtimeVersion, and the embedded public key come from the **native** side
(per build flavour), so they can't be tampered from JS.

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

**Automated:** `npm run test:core` → **14/14** (Ed25519 / AES-GCM / canonical-JSON / targeting /
fingerprint, incl. tamper & forgery). `npm run test:e2e` → **10/10** (publish → check → download
→ verify+decrypt, plus runtimeVersion gate, replay, one-time token, force-update, auto-pause) —
now over the **asymmetric device-key (ECDSA P-256)** request auth, including forged-signature and
replay rejection. `npm run test:express` → **7/7** (the distributor mounted inside a real Express
app behind a global body parser: raw-byte signature verification, `verifyEnrollToken` gate, and
the `onConfirm` hook). All four TypeScript packages typecheck clean.

> The on-device matrix below was first captured on the earlier symmetric-secret build; the
> request-auth layer has since moved to the **hardware device key**, which is covered by the
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
  in the **Secure Enclave / Keychain** via `Security.framework` (`SecKey`, EC P-256, exported as
  SPKI-DER; `ecdsaSignatureMessageX962SHA256`); config via Info.plist; `bundleURL()` hook.
  (Static-lib pod → Swift header via `__has_include` guard.)
- **Backend / CLI / shared:** Node 20 + TypeScript, pure `node:crypto` (no external crypto
  deps), run via `tsx`.

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

## 13. Production roadmap (deferred — documented, non-blocking)

The POC proves the **behavior** is production-grade; the following are the remaining
**infra/ergonomics** steps to ship for real:

- **TLS certificate/public-key pinning** and **device attestation** (Play Integrity / App
  Attest) — already have the modular plug-in interfaces; implement and inject. **Attestation is
  intentionally deferred:** the app isn't on the Play Store / App Store yet, so the attestation
  services can't be exercised end-to-end; the hardware device-key enrollment is the chosen
  non-attestation control in the meantime, and attestation slots in later via `IntegrityAttestor`
  without touching the core.
- **iOS Xcode `Debug/Release-{Dev,UAT,Prod}` configs + schemes** (the xcconfig files exist;
  this is IDE/CI plumbing).
- **Backend infra:** swap in-memory/disk for **Postgres + Redis + object storage**; put it
  behind your existing API gateway (the route core is framework-agnostic, so this is an
  adapter + store swap, not a rewrite).
- **Key custody & rotation:** Ed25519 *signing* keys in **CI secrets / KMS / HSM**, never on a
  laptop; embed a **key ring** (`keyId` on each manifest) so a signing key can be rotated across
  a transition build that trusts old+new before retiring the old. **Device keys** rotate for free:
  re-enrolling overwrites the stored public key per install, so a wiped/rotated keystore key
  simply re-registers on next launch.
- **Crash-analytics source maps:** upload the Hermes-composed source map per OTA to
  Crashlytics/Sentry (keyed by a `debugId`) so on-device OTA crashes symbolicate.
- **Differential (bsdiff) patches** + wifi/consent gating for large downloads.
- **Local web console (CRM)** over the backend admin API.
- **Cut over the real app** (go-trade-mobile) and remove the managed SDK — intentionally not
  touched in the POC; do it after the example proves the loop (it has).

---

## 14. Honest limitations of the POC

- Confidentiality against an **active** MITM waits for the pinning plug-in (integrity does not).
- The backend is a single-node in-memory/disk POC (data persists to JSON files); not HA.
- The example uses in-memory client storage (re-enrolls per cold start). Re-enroll is cheap and
  idempotent with the hardware device key (it re-registers the same public key), but a real app
  should still inject AsyncStorage/secure storage via the same `OtaStorage` interface to keep a
  stable `installId`.
- iOS multi-flavour was validated via `xcodebuild` build-setting overrides; the IDE scheme setup
  is pending.
- Asset OTA is supported by the archive format, but the example exercised JS-only changes.
- The device key uses the **Secure Enclave on hardware**; on the iOS **Simulator** (no Enclave)
  it falls back to a software Keychain key — functionally identical for the protocol, but the
  hardware-isolation guarantee only holds on real devices.
