# dash-ota v2 — production revamp design

Date: 2026-09-09 · Status: approved in discussion, spec for review · Scope: `packages/shared`,
`packages/backend`, `packages/cli`, `packages/rn`, `website/docs`.

## 1. Why

Production incident 2026-09-08 (go-trade 1.0.3–1.0.5): every OTA "applied" then lost all bundled
images and silently reverted on the next launch. Root cause: React Native calls the host's
`getJSBundleFile()` / `bundleURL()` 5–6 times per launch; each call ran `resolveBundleAtLaunch`,
which counts a boot attempt, so the third call tripped the crash-loop breaker (`MAX_BOOT_ATTEMPTS =
2`) on the first boot of every new bundle. The breaker `gc()`-deleted the slot directory while the
memory-mapped bytecode kept running: `drawable-*/…png` beside it vanished (ENOENT in Fresco and
Glide), and the bundle was blocklisted.

Measured payload for the same app: 29.9 MB per update, uncompressed, single AES blob — 27.4 MB
Hermes bytecode + 2.5 MB PNG (121 files). zstd -19 of the bytecode alone is 7.6 MB; a zstd
`--patch-from` frame between two builds with a small JS change is 2.4–2.8 MB, and 48 KB for
near-identical builds.

The revamp fixes the boot accounting for good, replaces the whole-blob payload with per-file
content-addressed blobs so unchanged files are never re-sent, compresses everything that
compresses, adds bytecode deltas, and closes the documented iOS whole-body-in-RAM limitation.

Decisions already taken with the owner: **hard protocol cut** (no dual-format publishing; old
clients get a tombstone), **encryption stays available as a per-release option** (default on),
**deltas are in scope** (bases = prior releases + registered store builds).

## 2. Invariants (the correctness model)

1. **Authenticity** — only a manifest whose Ed25519 signature verifies against a key embedded in
   the binary can select executable content. Every file the runtime loads is either embedded in
   the signed native app or listed in such a manifest with a matching SHA-256 verified on device.
   "Already present on disk" is never a trust state.
2. **Atomicity** — a staged bundle is never `current` until its slot is complete and verified; it
   is never `lastKnownGood` until an explicit health commit.
3. **Lifetime safety** — no process can lose files underneath a running or mapped bundle. Slot
   directories are immutable after staging; GC runs only at startup, before bundle selection, and
   never touches `current` or `lastKnownGood`.
4. **Bounded resources** — download and staging never hold more than one blob's plaintext in
   memory (plus the memory-mapped patch base in milestone 3).

## 3. Milestones

| # | Ships | Packages | Wire change |
|---|---|---|---|
| M1 | Loader memoisation + boot accounting fix + slot migration | rn 0.3.2 | none |
| M2 | Protocol v2: manifest schema 2, per-file blobs, zstd, reuse, resume, streamed publish, tombstone, `verify-release` | shared 0.3, backend 0.3, cli 0.3, rn 0.4 | yes (hard cut) |
| M3 | Bytecode deltas + `register-native-build` | all, minor bumps | additive to v2 |

M1 is native-only and ships first so the consuming app can cut a store release immediately. M2 and
M3 are one wire migration: M3 only adds optional manifest fields and one query parameter.

## 4. M1 — boot accounting

### 4.1 Resolve once per process
`DashOtaBundleLoader.getBundleFile()` (Kotlin) and `DashOtaBundleLoader.bundleURL()` (Swift)
memoise the result of `resolveBundleAtLaunch` for the process lifetime (synchronized / NSLock).
Already implemented and verified on both platforms 2026-09-09.

### 4.2 Attempt forgiveness (the "boot beacon")
State gains two per-launch marks written by native:

- `launch.beaconAt` — set when the TurboModule is initialised by JS (`initialize()` / first
  `getState`). Proves the bundle reached JS.
- `launch.pausedAt` — set on `Activity.onPause` (Android, via `ActivityLifecycleCallbacks`) /
  `UIApplication.willResignActiveNotification` (iOS). Proves the user left the app (or at least
  that the OS took the foreground) rather than the app dying. Pause/resign-active is used rather
  than stop/background because an iOS swipe-kill from the app switcher only guarantees
  resign-active.

Rule in `resolveBundleAtLaunch`, for a `current` slot in `trial`:
```
prev = state.launch                       // marks from the PREVIOUS process
forgiven = prev.beaconAt && prev.pausedAt // user-driven exit after JS ran
state.launch = {}                         // reset for this process
attempts = state.bootAttempts
if forgiven && attempts > 0: attempts -= 1        // refund the previous launch
if attempts >= MAX_BOOT_ATTEMPTS (2): disable + revert (as today, minus the gc — see §4.4)
if !userReload: attempts += 1                      // this launch spends one
```
Trace: pending → launch 1 spends attempt 1. Crash → launch 2 spends attempt 2 and runs. Crash →
launch 3 sees 2 ≥ 2 and reverts: two real crashes. A user pause+kill after the beacon is refunded
at the next launch, so it can repeat forever. A crash never writes `pausedAt` first, so
crash-before-JS and crash-after-JS both count.
`userReload` (explicit "restart to apply") keeps its existing meaning.

### 4.3 Slot migration
State gets `stateSchema: 2`. On load, a state without it is discarded entirely (embedded bundle
runs; the next check re-downloads). Slots from 0.3.x are broken by construction, so nothing is lost.

### 4.4 GC timing
`gc()` is called only from `resolveBundleAtLaunch` before selection and from `rollback()` when
invoked by JS at startup. The crash-loop branch no longer deletes anything in the process that
tripped it; it marks and returns, and the next launch's startup GC cleans up.

## 5. M2 — protocol v2

### 5.1 Manifest schema 2
```jsonc
{
  "schema": 2,
  "protocol": 2,
  "bundleId": "bnd_2_36_…", "runtimeVersion": "2", "bundleVersion": 36,
  "platform": "android", "channel": "prod", "appId": "com.kksl.gotradeindia",
  "createdAt": "…", "mandatory": false, "minNativeBuild": 6, "targetAppVersions": ">=1.0.6",
  "keyId": "gt_prod", "releaseNotes": "…",
  "encryption": { "mode": "aes-256-gcm", "contentKeyB64": "…" },   // or { "mode": "none" }
  "files": [
    { "path": "index.android.bundle", "role": "bundle", "sha256": "…", "size": 27014982,
      "blob": { "sha256": "…", "size": 7629311, "compression": "zstd", "ivB64": "…", "tagB64": "…" } },
    { "path": "drawable-xxhdpi/src_assets_images_logo.png", "sha256": "…", "size": 12345,
      "blob": { "sha256": "…", "size": 12373, "compression": "none", "ivB64": "…", "tagB64": "…" } }
  ],
  "patches": []   // M3, see §6
}
```
- `files[].sha256` / `size` describe the **plaintext** file (what lands on disk).
- `files[].blob` describes the **stored bytes**: `blob.sha256` is the hash of exactly what
  `GET …/blobs/{blob.sha256}` returns (after encryption, if any); `compression` is applied before
  encryption; `ivB64`/`tagB64` present only when `encryption.mode = aes-256-gcm`.
- Exactly one entry has `role: "bundle"` (the Hermes bytecode). Its `path` is the platform entry
  file name.
- `appId` is verified natively against the package name / bundle identifier.
- Path rules (validated at sign time, publish time, and on device): relative, POSIX separators,
  no empty segment, no `.` or `..` segment, no leading `/`, no NUL, max 512 bytes.
- `validateManifestShape` rejects `schema !== 2`.

Signature: unchanged mechanism (`canonicalBytes` + Ed25519). The signed object is the whole
manifest including `files[].blob` and `patches`.

### 5.2 Compression and encryption (shared)
- Compression: zstd, default level 19 for `role: bundle`, level 3 for the rest. Skipped when the
  extension is in `{png,jpg,jpeg,webp,gif,mp4,m4a,mp3,zip,gz,zst,woff,woff2}`, or when the
  result is ≥ 98 % of the input (this catches fonts and other already-dense files).
- Encryption: AES-256-GCM per blob, one random 32-byte content key per release in the manifest,
  random 12-byte IV per blob, tag stored separately in the manifest, AAD = `bundleId + "/" +
  files[].sha256` (binds each blob to its release and plaintext identity).
- `encryption.mode = none` stores compressed plaintext; `blob.sha256` still authenticates it.

### 5.3 Blob addressing and storage (backend)
- Key: `releases/{bundleId}/{blob.sha256}` in `BlobStore`. Per-release namespace keeps
  authorisation and retention simple; cross-release dedup is not a goal (storage is cheap).
- `BlobStore` interface change: `put(key, Readable | Buffer)`, `stat(key)`,
  `openReadStream(key, range?: {start, end})`, `delete(key)`, `deletePrefix(prefix)`.
  Disk and S3 adapters implement Range natively.
- `ReleaseRecord` gains `schema`, `bundleSha256`, `blobCount`, `totalBytes`, `finalized`.

### 5.4 Device endpoints (v2)
All under `/ota/v2/`. Request signing (device key, nonce, timestamp) unchanged.

- `POST /enroll` — unchanged shape.
- `POST /check` — request adds `protocol: 2`, `currentBundleId` (`""` when embedded),
  `currentBundleSha256` (sha256 of the running bytecode file; embedded included). Response:
  `{ update: SignedManifest | null, downloadToken?, serverNonce, nativePolicy }`. `downloadToken`
  is bound to `bundleId` + `installId`, valid `downloadTokenTtlMs` (default now 30 min), reusable.
- `GET /releases/{bundleId}/blobs/{blobSha256}` — header `x-ota-download-token`. Supports
  `Range: bytes=a-b` (206) and returns `ETag: "<blobSha256>"`, `Cache-Control: immutable`. 404 for
  unknown blob, 403 for token mismatch, 410 when the release is rolled back.
- `POST /confirm` — unchanged.
- Tombstone: `POST /ota/v1/check` and `POST /ota/v1/enroll` stay mounted, verify nothing, and
  return `{ update: null, serverNonce, nativePolicy: <channel policy with severity forced to
  "hard"> }`. Every hit increments `retiredClients[channel][platform]` (exposed on
  `GET /admin/releases` as `retiredClients`). `/ota/v1/download` and `/ota/v1/confirm` return 410.

### 5.5 Publishing (admin)
Replaces the single base64 JSON body.
1. `POST /admin/releases` `{ signedManifest, rolloutPercentage }` → validates shape + signature +
   trusted key + path rules, stores the record with `finalized: false`, returns
   `{ bundleId, missing: [blobSha256…] }` (blobs not yet present under that release).
2. `PUT /admin/releases/{bundleId}/blobs/{blobSha256}` — raw `application/octet-stream`, streamed
   to the blob store through a hashing pass; rejected (400) if the hash or size disagrees with the
   manifest; idempotent (200 if already present and matching).
3. `POST /admin/releases/{bundleId}/finalize` — verifies every `files[].blob` (and `patches[]`)
   exists with the right size, flips `finalized: true`. Only finalized releases are eligible in
   `pickEligible`.
Body-size: the built-in router streams PUT bodies with a per-blob cap (`maxBlobBytes`, default
64 MiB); the Express adapter mounts the blob route before any JSON parser and documents it.

### 5.6 Device pipeline (rn native)
`downloadAndStage(manifestJson, signatureB64, downloadToken)` — URL derived from the embedded
server URL. Steps, both platforms, identical semantics:
1. Verify signature, `schema == 2`, `appId`, `runtimeVersion`, downgrade guard, disabled list,
   path rules. Reject before any I/O.
2. Build `have`: map `sha256 → path` from the `current` and `lastKnownGood` slot records
   (`files` persisted at stage time); on iOS additionally hash files under `Bundle.main/assets`
   once per process and add them. Build `want = files whose sha256 ∉ have`, and (M3) swap the
   bundle entry for a patch when applicable.
3. Staging dir `staging/{bundleId}/` (survives process death). For each `want` entry, in a small
   pool (concurrency 3): `GET blob` with `Range` resuming from the existing `tmp/{blobSha256}.part`
   length; stream to disk hashing as it goes; on completion compare `blob.sha256`; decrypt +
   decompress in a streaming pass to `staging/{path}.tmp` (GCM tag verified before the plaintext
   is renamed into place); verify plaintext `sha256` + `size`; rename to `staging/{path}`.
   Blobs already complete in `staging/` are skipped on resume.
4. For each reused entry: hard-link (`Os.link` / `linkItem`) the source file into
   `staging/{path}`, fall back to copy; re-hash the result and reject on mismatch (invariant 1).
5. Commit: `rename(staging/{bundleId} → bundles/{bundleId})`, write the slot record
   `{ bundleId, version, runtimeVersion, nativeBuild, bundleSha256, files: {path: sha256} }`,
   set `staged`. Any failure leaves `staging/` in place for the next attempt; a change of
   `bundleId` clears it.
6. Progress: emit `onProgress { bundleId, bytesDone, bytesTotal, filesDone, filesTotal }` events
   (NativeEventEmitter); JS exposes `ota.progress` in the UI model.

Errors are typed (`sig_invalid`, `app_mismatch`, `path_invalid`, `blob_hash_mismatch`,
`file_hash_mismatch`, `network`, `disk_full`, `patch_failed`) and surfaced as `ota.error.code`.

### 5.7 JS provider changes
- `CheckRequest` gains the fields in §5.4; `getCurrentBundleMeta()` returns `bundleSha256`.
- `OtaUi` gains `progress: { done, total } | null`.
- `verifyRelease` reference implementation moves into `packages/shared` (Node only) and is used
  by the CLI and tests: given a manifest + a blob fetcher, reassemble and verify a release exactly
  as the device does.

## 6. M3 — bytecode deltas

- CLI computes `zstd --patch-from=<base> --ultra -22 --long=27` frames of the new bytecode against
  each base: the bytecode of the last `--patch-bases N` (default 3) finalized releases on the same
  channel/platform/runtimeVersion, plus every registered native build for that runtimeVersion.
  Bases are fetched from the server (`GET /admin/releases/{id}/blobs/{sha}` + manifest key) or
  from `GET /admin/native-builds/{platform}/{nativeBuild}`.
- Manifest `patches[] = { baseSha256, blob: { sha256, size, compression: "zstd-patch", ivB64?,
  tagB64? } }` — the patch is itself a blob under the release namespace.
- `/check` picks nothing; the device compares `currentBundleSha256` with `patches[].baseSha256`
  and requests the patch blob instead of the bundle blob. Apply: memory-map the base file
  (`current` slot bytecode, or the embedded bundle copied once to `bases/{sha256}`), decode with
  `refPrefix(base)` + `windowLogMax = 27`, stream output to `staging/{path}.tmp`, verify
  `files[bundle].sha256`. Any failure → delete partial output, fall back to the full bundle blob,
  record `patch_failed` in `/confirm` reason.
- `dash-ota register-native-build --artifact <apk|aab|app|ipa|hbc> --platform --native-build N
  --runtime-version R` extracts `assets/index.android.bundle` / `main.jsbundle`, uploads it to
  `native-builds/{platform}/{nativeBuild}` (encrypted with a server-side key when encryption is
  on), records its sha256.
- Gates before implementation: (a) decode spike on Android emulator + iOS simulator with peak RSS
  measured, (b) patch sizes across the real 1.0.3 → 1.0.4 → 1.0.5 bytecodes built from tags, (c)
  zstd-jni 16 KB ELF alignment check, else vendor decompress-only libzstd built with
  `-Wl,-z,max-page-size=16384`.

## 7. CLI

- `publish`: v2 pipeline (§5.2, §5.5, §6); flags `--no-encrypt`, `--compression-level`,
  `--patch-bases N` (0 disables), `--zstd <path>`; fails early if `zstd` is missing and patches
  or compression are requested. Retries each PUT 3× with backoff; a re-run resumes (server
  reports `missing`).
- `verify-release --bundle-id <id>`: enrolls a throwaway device key, runs `/check`, downloads
  through the device endpoints, reassembles into a temp dir with the shared reference
  implementation, prints file count, bytes downloaded vs reused (against `--base <bundleId>` if
  given), exit 1 on any mismatch.
- `register-native-build` (§6). `list` shows `schema`, `finalized`, `totalBytes`,
  `retiredClients`.

## 8. Versioning and rollout

- `react-native-dash-ota` 0.3.2 (M1) → 0.4.0 (M2) → 0.5.0 (M3); `@dash-ota/shared`, `backend`,
  `cli` 0.3.0 (M2) → 0.4.0 (M3). All 0.x minor bumps are breaking.
- Consumer order (go-trade): ship 0.3.2 in a store release now → deploy backend 0.3 → cut the
  store release with rn 0.4 (adds the zstd pod / AAR, native policy gate rendered in-app) →
  publish with cli 0.3 → `register-native-build` for that store build → M3.

## 9. Testing

- shared: manifest v2 validation (incl. every path rule), blob crypto round-trip with AAD, zstd
  round-trip, reference reassembly (full, partial reuse, tampered blob, tampered plaintext).
- backend e2e: three-step publish (missing list, idempotent PUT, hash mismatch 400, finalize
  refusing incomplete), Range 206/416, token scoping (other release → 403), rolled-back → 410,
  tombstone response + `retiredClients` counter, `pickEligible` ignores non-finalized.
- rn native, manual matrix on emulator + simulator with the mandatory dev-channel harness: fresh
  install full download; second update with reuse (bytes downloaded ≪ total); kill mid-download
  → resume; corrupt a blob on the server → typed error, no partial slot; deliberately crashing
  bundle → disabled after 2 real crashes; two force-kills within 5 s → not disabled; iOS app-
  bundle asset reuse; M3 patch apply + forced fallback.
- CI: `verify-release` against every published release; `npm run ci` green.

## 10. Documentation (website/docs)

Update in place: `architecture/manifest-schema.md` (v2), `architecture/soa1-archive.md` →
`architecture/blobs.md`, `architecture/slot-model.md` (state schema 2, launch marks, GC timing),
`concepts/crash-loop.md` (memoisation + forgiveness rule), `backend/endpoints.md`,
`backend/store.md`, `backend/providers.md` (BlobStore API), `backend/express.md` (blob route
before JSON parser), `cli/commands.md`, `cli/release-workflow.md`, `react-native/android-setup.md`
and `ios-setup.md` (zstd dependency), `react-native/troubleshooting.md` (vanishing images
symptom), `security/threat-model.md` + `limitations.md` (optional encryption, AAD binding, iOS
memory bound closed), `contributing/roadmap.md`. New: `concepts/delta-updates.md`,
`guides/migrate-to-v2.md`.

## 11. Out of scope

Signed revocation / minimum-version channel, TLS pinning, attestation, CDN configuration (blob
URLs are content-addressed and immutable so a CDN is a deployment choice), server-side
cross-release dedup, bsdiff.
