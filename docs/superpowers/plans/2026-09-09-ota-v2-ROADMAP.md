# dash-ota v2 revamp — master roadmap and handoff

**Read this first.** It is the single entry point for the OTA v2 workstream. It carries the status
board, the locked decisions, the facts already verified (do not re-derive them), and the phase
order. If a session ends, the next agent resumes from the Status board below.

- **Spec (source of truth for all design decisions):** `docs/superpowers/specs/2026-09-09-ota-v2-revamp-design.md`
- **Consuming app:** `/Users/essence/ReactNative/go-trade-mobile` (GoTradeIndia, RN 0.81, prod OTA channel)
- **Owner:** Priyanshu Agrawal. Decisions marked "owner" below were taken in conversation; do not relitigate them.

## How to resume

1. Read this file, then the spec.
2. Find the first unchecked phase in the Status board.
3. If that phase has a detailed plan listed, follow it. If it does not, work from the spec section
   named in the phase. **Do not write another exhaustive plan document** — see Rules of engagement.
4. Update the Status board as you go. That is what makes the next handoff cheap.

---

## Status board

| # | Phase | Packages | Detailed plan | State |
|---|---|---|---|---|
| 0 | Investigation, root cause, spec, loader fix | rn | this file + spec | ✅ done |
| 1 | **M1** boot accounting (rn 0.3.2) | rn | `2026-09-09-m1-boot-accounting.md` (full) | ✅ done — `253b165`, verified both platforms |
| 2 | **M2a** shared: manifest v2, zstd, per-blob crypto | shared | `2026-09-09-m2-shared-backend.md` Tasks 1–4 | ⬜ next |
| 3 | **M2b** backend: router, providers, store, routes, tombstone | backend | same file Tasks 5–8; routes onward from spec §5.3–§5.5 | ⬜ |
| 4 | **M2c** CLI: 3-step publish, `verify-release` | cli | `2026-09-09-m2-cli-docs.md` Tasks 1–7 (full) | ⬜ |
| 5 | **M2d** rn native + JS (0.4.0) | rn | none — spec §5.6, §5.7 | ⬜ |
| 6 | **M2e** documentation site | website | `2026-09-09-m2-cli-docs.md` Tasks 8–13 (full) | ⬜ |
| 7 | **M3** bytecode deltas | all | none — spec §6, gated on spikes | ⬜ |
| 8 | Rollout in go-trade | consuming app | this file, Rollout section | ⬜ |

Phases 2–6 are one wire migration and must ship together. Phase 1 ships on its own, first.

---

## The problem being fixed

Production incident 2026-09-08 (go-trade 1.0.3–1.0.5): every OTA applied, then lost all bundled
images, then silently reverted on the next launch.

Root cause, reproduced and confirmed on an Android emulator 2026-09-09: React Native reads the
host's `getJSBundleFile()` / `bundleURL()` 5–6 times per launch. Each read ran
`resolveBundleAtLaunch`, which counts a crash-loop boot attempt. With `MAX_BOOT_ATTEMPTS = 2` the
third read tripped the breaker on the **first** boot of every new bundle, and the breaker's `gc()`
deleted the slot directory while the Hermes bytecode was still memory-mapped. The JS kept running
from the mapped file; every `require()`d image beside it returned ENOENT in Fresco and Glide.

Secondary problem: the payload is 29.9 MB uncompressed per update (27.4 MB bytecode + 2.5 MB of
121 PNGs) as a single AES blob, with no compression, no reuse, and no resume.

## The four invariants (spec §2)

1. **Authenticity** — only a signed manifest selects executable content; "already on disk" is never a trust state.
2. **Atomicity** — never `current` before the slot is complete and verified; never `lastKnownGood` before an explicit health commit.
3. **Lifetime safety** — no process loses files under a running or mapped bundle; GC only at startup, before selection.
4. **Bounded resources** — never more than one blob's plaintext in memory.

---

## Decisions locked

| Decision | Value | By |
|---|---|---|
| Backward compatibility | **None.** Hard protocol cut; old clients get a tombstone | owner |
| Old-client behaviour | Tombstone returns no update **plus a hard native-update policy**, and counts hits | owner via review |
| Encryption | **Per-release option, default on.** AES-256-GCM per blob, AAD binds blob to release + plaintext | owner via review |
| Bytecode deltas | **In scope**, last phase. Bases = prior releases + registered store builds | owner |
| Blob addressing | Per release: `releases/{bundleId}/{blobSha256}`. Not global | review |
| Transport | Plain `GET` per blob with Range, not a custom multiplexed stream | review |
| Crash-loop | Attempt refunded only if the previous process reached JS **and** was paused by the user | review |
| Mark naming | `launch.beaconAt` + `launch.pausedAt` (pause/resign-active, not stop/background) | this work |

Two of these came from an adversarial review by an outside model, which also caught that the first
boot-beacon design would let a crash-after-JS loop forever. See the spec for the corrected rule.

## Facts already verified — do not re-derive

| Fact | Value | How verified |
|---|---|---|
| Payload split | 27.4 MB bytecode + 2.5 MB assets (121 files) = 29.9 MB | measured on a real publish |
| gzip whole payload | 11.7 MB | `tar \| gzip -9` |
| zstd -19 of bytecode | 7.6 MB | `zstd -19` |
| zstd patch, small JS change | 2.4 MB at `--ultra -22 --long=27`, 2.8 MB at `-19` | `zstd --patch-from` |
| zstd patch, near-identical builds | 48 KB | same |
| Patch generation time | ~11 s for the 27 MB bytecode | `/usr/bin/time` |
| Node zstd binding | `@mongodb-js/zstd@^7.0.0`, **async** `compress(buf, level?)` / `decompress(buf)` | read its `index.d.ts` from the npm tarball |
| Its engine floor | `node >= 20.19.0` (dev machine runs 20.20) | its `package.json` |
| Node built-in zstd | Unusable: no dictionary support, and only from Node 22.15 | Node docs |
| CLI bundling | esbuild `--packages=bundle` cannot inline the native addon; `--external:@mongodb-js/zstd` works alongside it | ran esbuild, import preserved |
| zstd-jni Android artifact | `com.github.luben:zstd-jni:1.5.7-16@aar` exists on Maven Central | listed the repo |
| **zstd-jni 16 KB alignment** | **Passes.** All four ABIs report LOAD align `0x4000` | parsed the ELF program headers from the AAR |
| iOS zstd | `libzstd` CocoaPod available; `ZSTD_DCtx_refPrefix` present for M3 | vendor docs |
| go-trade native policy gate | **Not rendered in the app.** `nativePolicy` is unused in its source | grepped the app |

The 16 KB result means the "vendor a decompress-only libzstd" fallback is **not needed**. Drop it
from phase 5 unless a future zstd-jni bump regresses.

---

## Phases

Each phase ends green on its own. Do not start the next before the previous one's exit criteria pass.

### Phase 1 — M1 boot accounting (rn 0.3.2)

Fixes the production bug. Native only, so it needs a store release, and it ships ahead of everything else.

- **Follow:** `2026-09-09-m1-boot-accounting.md` (7 tasks, complete, with code).
- **Files:** both `DashOtaBundleLoader` (already patched in the working tree), both `DashOtaStore`, `DashOtaModule.kt`, `DashOtaImpl.swift`, `packages/rn/package.json`, plus three docs pages and a CHANGELOG.
- **Exit:** Android emulator and iOS simulator both apply a mandatory dev-channel bundle, show zero ENOENT, and report healthy on the server; three force-kills within the health window do **not** disable the bundle; a deliberately crashing bundle **is** disabled after two real crashes.

### Phase 2 — M2a shared

- **Follow:** `2026-09-09-m2-shared-backend.md` Tasks 1–4.
- **Delivers:** `validatePath`, zstd compression module, AES-GCM with AAD, manifest v2 types and validation, async `buildReleaseV2` / `verifyReleaseV2`, `CheckRequestV2`. Removes `buildRelease`, `openRelease`, `packArchive`, `unpackArchive`.
- **Exit:** `npm run test:core` green.

### Phase 3 — M2b backend

- **Follow:** same file Tasks 5–8 for the router, providers, adapters, config and store. **Routes onward have no written plan** — build them from spec §5.3–§5.5.
- **Still to build:** device routes `/ota/v2/{enroll,check,confirm}` and `GET /ota/v2/releases/:bundleId/blobs/:blobSha256` (token auth, Range/206/416, ETag, immutable cache, 403/404/410); admin three-step `POST /admin/releases` → `PUT .../blobs/:sha` → `POST .../finalize`, plus `GET /admin/releases/:bundleId` (the CLI's `--base` needs it); delete `POST /admin/publish`; v1 tombstone with the retired-client counter; the Express mount-ordering fix; e2e and smoke test extensions; versions to 0.3.0.
- **Exit:** `npm run ci` green, e2e covers the full v2 flow.

### Phase 4 — M2c CLI

- **Follow:** `2026-09-09-m2-cli-docs.md` Tasks 1–7 (complete, with code). Task 1 Step 4 carries the native-addon packaging fix.
- **Exit:** `npm run test:cli` green; `dash-ota verify-release` reassembles a published release and exits 1 on a tampered blob.

### Phase 5 — M2d rn native and JS (0.4.0)

No detailed plan. Build from spec §5.6 and §5.7. The shape:

- Per-blob `GET` with Range resume into `tmp/<blobSha>.part`, streaming SHA-256, verify blob hash and size.
- Decrypt (AAD = `bundleId + "/" + fileSha256`), then decompress, then verify plaintext hash and size, then atomic rename into `staging/<bundleId>/`.
- Reuse by hash from `current` and `lastKnownGood` via hard-link with **mandatory re-hash**; iOS also reuses `Bundle.main` assets.
- Path validation and `appId` check before any I/O.
- Slot record gains `bundleSha256` and `files: {path: sha256}`.
- Staging survives process death and resumes; a different `bundleId` clears it.
- Typed error codes; progress events via `onDashOtaProgress`.
- Android `implementation("com.github.luben:zstd-jni:1.5.7-16@aar")`; iOS `libzstd` pod.
- **Exit:** fresh install downloads everything; a second update downloads far less; kill mid-download resumes; a corrupted blob yields a typed error and no partial slot.

### Phase 6 — M2e documentation

- **Follow:** `2026-09-09-m2-cli-docs.md` Tasks 8–13 (complete). Covers manifest schema v2, a new blobs page replacing SOA1, endpoints, store and providers, Express mounting, CLI commands and workflow, Android and iOS setup, security threat model and limitations, the migration guide, and the roadmap page.
- **Exit:** `cd website && npm run build` passes (broken links throw).

### Phase 7 — M3 bytecode deltas

Gated on two spikes before any code: decode on both platforms with peak memory measured, and patch
sizes across the real 1.0.3 → 1.0.4 → 1.0.5 bytecodes built from git tags. Then implement spec §6.

### Phase 8 — rollout in go-trade

Order matters: ship rn 0.3.2 in a store release → deploy backend 0.3 → cut the store release with
rn 0.4 → publish with cli 0.3 → register that build's bytecode for M3.
Also render the native-policy gate in the app; it is currently unused, so the tombstone's hard
policy would be invisible to existing users.

---

## Working-tree state (as of 2026-09-09)

**secure-ota**, on `253b165`. Phase 1 is committed (`0be9174` docs, `253b165` the fix). Only
`package-lock.json` is dirty, and that predates this workstream — leave it.

Phase 1 also fixed two bugs found while implementing, beyond the spec:

- GC kept only `current` + `lastKnownGood`, so a bundle downloaded inside the health window was
  deleted by the `markHealthy` sweep before it could be applied. The keep-set now covers `pending`
  and `staged`.
- Returning to the foreground now clears the pause mark, so a bundle that pauses, resumes and then
  crashes is no longer forgiven, and iOS transients (a banner, an incoming call) are discarded.

**Phase 1 evidence (2026-09-09, Android emulator + iOS simulator):** a mandatory dev bundle applies
with zero ENOENT and all 115 assets intact; three force-kills while on trial leave `bootAttempts`
pinned at 1 instead of climbing to disabled; a deliberately crashing bundle is still disabled after
two real crashes and reported to the server (`adoption.failed = 1`).

**go-trade-mobile**, on `feat/reports-changes` at `f6bc5ad1` (pushed), uncommitted:

- `ios/Podfile.lock` — DashOta 0.3.2 from the local tarball.
- `scripts/dash-ota-publish.mjs` — added `--target-app-versions` and `--mandatory` pass-throughs.
- `node_modules/react-native-dash-ota` is the **local 0.3.2 tarball** installed with `--no-save`; `package.json` still says `^0.3.1`. Re-install it after any `npm ci`.
- Do **not** commit `docs/worflow-json-2.json` or `tools/onboarding-simulator/*` (owner's standing rule).

**Server state:** all four prod OTA releases published 2026-09-08 are rolled back. Dev-channel
releases v34/v35 (android) and v22 (ios) were verification publishes; v34 is rolled back.

## Rules of engagement

- **No more exhaustive plan documents.** One such document cost ~512k tokens and ended the owner's
  usage window in minutes. The spec is the design artifact; write code, not prose about code.
- Budget any subagent explicitly and prefer one over parallel fan-out.
- One consolidated commit per task. **No `Co-authored-by` trailers.**
- Stage files explicitly; the owner edits in parallel.
- Never log tokens, keys or PII. Never trigger real trading, order or payment actions.
- Verify on device before claiming a native change works. `set -o pipefail` before piping gradle or xcodebuild.

## Open questions

- Whether to keep AES-GCM at all once encryption is per-release optional. The outside review called
  it security theatre because the key rides in the signed manifest; the owner's context is a
  SEBI-regulated trading app, so the optics of a plaintext bundle on a CDN may decide it.
- M3 base retention policy: how many prior releases to keep bytecode for.
