# dash-ota — closure plan

How the in-flight work gets finished, verified and closed. The roadmap says *what* to build; the
library QA plan says what a *public* library would need. This says what "done" means for each phase,
each layer and the whole, and what evidence closes it.

Companion to `2026-09-09-ota-v2-ROADMAP.md` (state board) and `2026-09-09-library-grade-qa-plan.md`
(the deeper programme).

---

## 0. Rules that apply to every gate

Five of these come from mistakes actually made this week. They are cheap and they each caught
something real.

1. **Every claim carries its evidence and its limitation.** "Verified on both platforms" is not a
   result. "Applied a mandatory dev bundle on emulator and simulator, zero ENOENT, not tested on a
   physical device" is.
2. **Assert the precondition, not just the outcome.** A forgiveness test passed trivially because the
   bundle had already left trial state, so nothing was being counted. Read the state you depend on
   *before* asserting the behaviour.
3. **Prove the artifact under test is the one installed.** A verification run silently exercised the
   previous build because a relative path resolved wrongly and `adb install` failed unnoticed. Check
   the install succeeded and the binary timestamp.
4. **A security test must isolate the mechanism it names.** A test claimed the AEAD binding caught a
   swapped blob when the hash caught it a layer earlier. Construct the case so the named mechanism
   is the only thing that can reject it.
5. **Closed means reproducible by someone else.** A manual run by one person is evidence, not
   closure. Anything only I can re-run is open.
6. **No phase closes with a red tree.** `npm run ci` green, and the docs site builds.

---

## 1. State ledger — as of 2026-09-09, verified while writing this

| Item | State |
|---|---|
| Phase 1 (rn 0.3.2 crash fix) | Committed on `main`, verified both platforms |
| **`main` is 13 commits ahead of `origin/main`** | **Unpushed. The production fix exists only on this machine.** |
| Phase 2 (shared, schema 2) | Committed on `feat/ota-v2`, 20 checks green |
| `feat/ota-v2` tree | **Red.** Backend does not compile against schema 2 |
| **`@dash-ota/shared` version** | **0.2.0, containing a breaking change. Never bumped.** |
| `@dash-ota/backend` / `@dash-ota/cli` | 0.2.1 / 0.2.0, both need 0.3.0 |
| npm `react-native-dash-ota` | **0.3.1 published; 0.3.2 (the fix) is not** |
| go-trade `package.json` | **Pins `^0.3.1` while 0.3.2 is installed via `--no-save`. A fresh `npm ci` silently restores the broken version.** |
| go-trade uncommitted | `scripts/dash-ota-publish.mjs` (my `--mandatory` / `--target-app-versions` flags), `ios/Podfile.lock` |
| go-trade dirty, do not stage | `docs/worflow-json-2.json`, `graphify-out/*`, `tools/onboarding-simulator/*` |
| Dev channel | `bnd_2_36`, `bnd_2_37` are deliberate crash tests, rolled back. Keep them that way |
| Prod channel | All four 2026-09-08 releases rolled back. No prod OTA is live |

Four of those rows are defects found by writing the ledger rather than by testing. That is the
argument for keeping it.

---

## 2. Definition of done — uniform, every phase

A phase is closed when **all seven** hold. Partial is open.

1. Code merged to `main`, not a branch.
2. `npm run ci` green on `main`, and `cd website && npm run build` green.
3. Automated tests exist for the phase's own logic and run in CI. Manual-only does not close.
4. Behaviour verified on the platforms it affects, with the evidence and its limitations written into
   the roadmap's phase row.
5. Documentation updated in the same commit: the docs site, the CHANGELOG, and the spec if the design
   moved.
6. Package versions bumped and the breaking-change note written.
7. Every deviation from the plan recorded in the plan, so nobody re-executes a superseded listing.

---

## 3. Layer gates

Applied to each layer whenever it is touched, independent of phase.

### Shared (`@dash-ota/shared`)
- `npm run test:core` green; every new exported symbol has a test.
- Public API surface snapshot updated deliberately (see §5).
- Version bumped when the wire format or an export changes. **Currently violated.**
- No payload bytes reachable from a signed object (regression guard already in the suite).

### Backend
- `npm run test:e2e` and `test:express` green.
- Authorisation matrix asserted: a token for release A cannot fetch release B; install X cannot use
  install Y's token; the admin token comparison is constant-time.
- Every route has a negative test: 400, 403, 404, 410, 413 as applicable.
- Provider adapters run in CI against real containers, or the README stops claiming support.
- Streaming paths bounded: no route buffers an unbounded body.

### CLI
- `npm run test:cli` green, including a stub-server end-to-end.
- The signing key never appears in output, errors, or a crash dump.
- Distinct, documented exit codes on every failure path.
- Resume after an interrupted upload proven by killing it mid-run.

### Native (Android + iOS)
- **The gate that does not exist yet:** Kotlin and Swift unit tests running in CI. Until then this
  layer cannot satisfy rule 5 and every native phase closes as "shipped, not closed".
- Both platforms built in **release** configuration, not debug.
- On-device or emulator run with the state file read directly, not inferred from logs.
- Concurrency: mutators exercised from competing threads.

### Docs
- Site builds with broken links throwing.
- Every code block in a changed page still reflects the shipped API.
- The troubleshooting table gains a row for any user-visible failure introduced or fixed.

### Consuming app (go-trade)
- Dependency resolves from a published version, not a local tarball.
- Podfile.lock committed alongside the version bump.
- A store build produced from a clean checkout, not an incrementally patched tree.

---

## 4. Per-phase closure

### Phase 1 — boot accounting (rn 0.3.2) · *shipped, not closed*

Done: both loaders memoised, forgiveness rule, wider GC keep-set, marks in their own file, native
launch logging, docs, CHANGELOG. Verified on emulator and simulator in release builds: apply with
zero ENOENT, three trial-state kills leaving the attempt count at 1, a crashing bundle disabled after
two crashes, the pre-0.3.2 upgrade path on both platforms.

To close:
- [ ] Push `main` to `origin`. It is 13 commits ahead and the fix exists on one machine.
- [ ] Publish `react-native-dash-ota@0.3.2` to npm.
- [ ] go-trade: change the dependency to `^0.3.2`, remove the `--no-save` tarball, `pod install`,
      commit `package.json`, `package-lock.json`, `ios/Podfile.lock` together.
- [ ] Run once on a **physical** Android device and a physical iPhone. The incident involved
      memory-mapped files and process lifetime; simulators model both imperfectly.
- [ ] Kotlin and Swift unit tests for the state machine, so the result is reproducible without me.
- [ ] Cut the store release. Until it ships, every existing install still has the broken loader and
      **no prod OTA may be published**.

### Phase 2 — shared, schema 2 · *committed, not closed*

Done: path rules, per-blob zstd, AAD-bound AES-GCM, manifest schema 2, `buildReleaseV2` /
`verifyReleaseV2`, `CheckRequestV2`, 20 checks including dedup, tampering, unencrypted releases and
edge cases. Measured: 27.92 MB to 9.44 MB full; 120 of 121 files reused on a one-line change.

To close:
- [ ] Bump `@dash-ota/shared` to 0.3.0 with a breaking-change note. **Currently 0.2.0.**
- [ ] Bounded decompression, or a written decision that the binding cannot do it and the native side
      must. Measured expansion is over 32,000x.
- [ ] A conformance vector for the bomb, the truncated blob, and the wrong-AAD case.
- [ ] Rewrite the AAD test so the binding is the only mechanism that can reject (rule 4).
- [ ] Merge to `main` — which requires phase 3, since the tree is red without it.

### Phase 3 — backend · *not started, and it unblocks the branch*

Steps, each ending green:
- [ ] Router: `:param` routes, `PUT`, streamed bodies, `Range` parsing.
- [ ] Providers: `BlobStore` v2 with ranged reads, reusable tokens, retired-client counters.
- [ ] Adapters: S3 ranges and stream puts, SQLite and Postgres counters, Redis token read.
- [ ] Config, spooled upload, the v2 `Store` (create, stage, finalize).
- [ ] Device routes `/ota/v2/{enroll,check,confirm}` and the ranged blob `GET` with ETag, 206, 416,
      403, 404, 410.
- [ ] Admin three-step publish, `GET /admin/releases/:bundleId`, delete `POST /admin/publish`.
- [ ] v1 tombstone with the retired-client counter; `/ota/v1/download` and `/confirm` return 410.
- [ ] Express mount ordering so a host's JSON parser cannot eat the blob `PUT`.
- [ ] e2e covering the full v2 flow plus the authorisation matrix; smoke test for mount ordering.
- [ ] Versions to 0.3.0. **Then `main` can go green again.**

### Phase 4 — CLI
Plan is written in full. Adds: key hygiene, resume after kill, exit codes, and a decision on Windows
support rather than a silent gap.

### Phase 5 — rn native (0.4.0) · *no plan, highest risk*
Build from spec §5.6 and §5.7. Non-negotiable at closure:
- [ ] `Cipher.doFinal`, never `CipherInputStream`, and a test with a tampered blob proving the tag
      failure is fatal rather than silently truncating.
- [ ] Decrypt to a temp file then stream the decompression, so the 25.8 MB plaintext is never
      resident. Peak RSS measured, not assumed.
- [ ] Reuse by hard-link **with mandatory re-hash**.
- [ ] Resume across app backgrounding, on a real device.
- [ ] Multi-process behaviour tested with a deliberately multi-process fixture app. Not a concern for
      go-trade (verified: single process) but it is for any other adopter.

### Phase 6 — docs
Plan written in full. Closes when the site builds and no page describes the v1 format.

### Phase 7 — bytecode deltas
Gated on two spikes before any code: decode on both platforms with peak memory measured, and patch
sizes across the real 1.0.3 to 1.0.5 bytecodes built from tags.

### Phase 8 — rollout in go-trade
Order is load-bearing: ship rn 0.3.2 in a store release, deploy backend 0.3, cut the store release
with rn 0.4, publish with cli 0.3, register the bytecode base. Also render the native-policy gate,
which the app currently ignores, so a retired client sees the store prompt.

---

## 5. Overall QA — only meaningful once assembled

Runs after phase 6, before phase 8, on `main`.

- [ ] **End-to-end on real devices:** publish with the real CLI to the real backend, fetch on a
      physical Android and iPhone, verify byte-identical staging and a working app.
- [ ] **Reuse proven end-to-end**, not just in the builder: second release downloads only what
      changed, measured on device.
- [ ] **Interrupt matrix on device:** kill mid-download, background mid-download, aeroplane mode
      mid-download, disk full. Each resumes or fails cleanly, never bricks.
- [ ] **Crash-loop end-to-end on v2:** a deliberately crashing v2 bundle is still disabled after two
      crashes and reported.
- [ ] **Upgrade path:** a device on 0.3.2 with a v1-era slot moves to 0.4.0 and a v2 release cleanly.
- [ ] **Retired client:** a 0.3.x device against a v2-only backend sees the tombstone and the store
      prompt, not a permanent error row.
- [ ] **Public API surface snapshot** committed and asserted in CI, across all four packages.
- [ ] **`verify-release` in CI** against a real published release.
- [ ] Peak RSS and resolver cost measured against budgets, with device classes defined.

---

## 6. Release gates

**Publish `react-native-dash-ota@0.3.2`:** phase 1 closed except the store release; CHANGELOG written;
`main` pushed.

**Merge `feat/ota-v2` to `main`:** phases 2 and 3 both green; `npm run ci` and the docs build pass;
versions bumped.

**Tag v2 / publish the rest:** phases 2 to 6 closed; §5 overall QA green; migration guide published.

**go-trade store release:** dependency on a published version; clean checkout build; release notes.

**Public 1.0:** the review's gate — two or three independent organisations choosing it for
self-hosting, data residency, customer-controlled keys or regulatory control. Plus signed revocation,
key rotation, and the audit log of who published what and when.

---

## 7. Open decisions — need the owner, not more engineering

| Decision | Why it blocks |
|---|---|
| Ship the 0.3.2 store release now, or wait and ship it with v2? | Until it ships, no prod OTA is safe to publish |
| Keep AES-GCM, or rely on signature plus TLS? | Changes the format; cheapest to decide before v2 merges |
| Supported matrix: which RN versions, architectures, OS levels, Windows yes or no? | The compatibility work is combinatorial theatre without it |
| Publish publicly at all? | Decides whether waves 2 and 3 of the QA plan are ever paid for |
| Commit the go-trade publish-script flags? | Small, but they are used by every verification run |
