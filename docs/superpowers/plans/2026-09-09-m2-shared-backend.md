# dash-ota M2 — shared + backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single-blob v1 payload with protocol v2 in `@dash-ota/shared` and `@dash-ota/backend`: manifest schema 2, per-file content-addressed blobs (zstd + optional AES-GCM with AAD), a three-step streamed publish, Range-capable blob downloads behind reusable release-bound tokens, and tombstoned v1 routes.

**Architecture:** `shared` owns the wire format — types, validation, path rules, per-blob compression/crypto, and `buildReleaseV2` / `verifyReleaseV2` as the reference implementation of what the CLI produces and the device consumes. `backend` stores blobs per release under `releases/{bundleId}/{blobSha256}` through the pluggable `BlobStore`, ingests them through idempotent streamed `PUT`s, serves them with HTTP Range support, and gates eligibility on `finalized`. The old `/ota/v1/*` device routes become counting tombstones.

**Tech Stack:** TypeScript 5.7 (`strict`, `noUncheckedIndexedAccess`), Node ≥ 20.19, ESM with `.js` import suffixes, `@mongodb-js/zstd` ^7.0.0 (prebuilt native addon; `compress(buf, level?)` / `decompress(buf)` are **async**), Node `crypto` for AES-256-GCM + Ed25519, the in-repo `node:http` router + Express adapter, tests are plain `tsx` scripts using `node:assert/strict` (no test framework), prettier (printWidth 130, single quotes, trailing commas), eslint flat config.

**Spec:** `docs/superpowers/specs/2026-09-09-ota-v2-revamp-design.md` — §5 (protocol v2), §8 (versioning), §9 (testing), §10 (docs). This plan covers `packages/shared` and `packages/backend` only; the CLI, the RN native/JS client, and M3 deltas are separate plans.

## Global Constraints

- **Hard protocol cut.** No v1 publishing or decoding path survives: `validateManifestShape` rejects `schema !== 2`; `POST /ota/v1/check` and `POST /ota/v1/enroll` become tombstones (`{ update: null, serverNonce, nativePolicy(severity: "hard") }`, counted per channel/platform); `GET /ota/v1/download` and `POST /ota/v1/confirm` return `410 protocol_retired`. `POST /admin/publish` is removed.
- **Blob key** = `releases/{bundleId}/{blob.sha256}` (per-release namespace; no cross-release dedup). `blob.sha256` is the SHA-256 of exactly the stored bytes.
- **Compression:** zstd level `19` for the `role: "bundle"` entry, `3` for everything else; skipped for extensions `{png,jpg,jpeg,webp,gif,mp4,m4a,mp3,zip,gz,zst,woff,woff2}` and whenever the result is ≥ 98 % of the input.
- **Encryption:** per-release random 32-byte key in the signed manifest (`encryption: { mode: "aes-256-gcm", contentKeyB64 }`), random 12-byte IV per blob, 16-byte tag in the manifest, AAD = `${bundleId}/${files[].sha256}`. `{ mode: "none" }` is allowed (compressed plaintext; `blob.sha256` still authenticates it).
- **Path rules** (sign/build, publish, device): relative, POSIX `/`, no empty segment, no `.` or `..` segment, no leading `/`, no NUL, ≤ 512 bytes.
- **Config:** `maxBlobBytes` default `64 MiB` (`OTA_MAX_BLOB_BYTES`); `downloadTokenTtlMs` default `30 min` (`OTA_DL_TTL_MS`, was 2 min); `maxBundleBytes` now caps the **sum of declared blob sizes** per release (default 100 MiB, unchanged).
- **Download token:** reusable within its TTL, bound to `bundleId` + `installId`, accepted only from the `x-ota-download-token` header.
- **Versions at the end of this plan:** `@dash-ota/shared` 0.3.0, `@dash-ota/backend` 0.3.0 (breaking 0.x minor bumps). `@dash-ota/cli` devDependency on shared must be bumped to `^0.3.0` in the same commit or the workspace install breaks (the CLI code itself is another plan).
- **Tests** are `tsx --conditions source` scripts wired through root `npm run test:*` scripts; `npm run ci` (`typecheck && lint && format:check && test`) must be green at Task 13. Expected red windows, stated where they occur: `tsc -p packages/backend` is red from Task 4 (shared drops v1 exports the two backend tests still import) until Task 11 ports the last of them; `npm run test:e2e` is red from Task 4 until Task 9; `npm run test:express` is red from Task 4 until Task 11. Every task still has its own green check.
- **Commits:** Conventional Commits (`feat(shared): …`, `feat(backend): …`, `docs: …`, `chore(release): …`), exactly one commit per task, **no `Co-authored-by` trailers**, stage files explicitly (never `git add -A` — the owner edits in parallel).
- **Cross-plan note for the CLI plan:** the CLI's esbuild bundle (`--packages=bundle`) cannot inline a native addon. The CLI build must add `--external:@mongodb-js/zstd` and list `@mongodb-js/zstd` in `packages/cli/package.json` `dependencies`.
- **Node:** ≥ 20.19 (engine floor of `@mongodb-js/zstd`); the dev machine runs 20.20. Node's built-in zstd (22.15+) is not used.

## File Structure

**packages/shared/src**
- `paths.ts` (new) — `validatePath`, `MAX_PATH_BYTES`. One responsibility: the path rules.
- `compression.ts` (new) — zstd wrappers, skip list, `compressForBlob`, `BlobCompression` type.
- `crypto.ts` (modify) — `aesGcmEncrypt` / `aesGcmDecrypt` gain an optional `aad`.
- `manifest.ts` (rewrite types + validation) — `ManifestV2` and friends, `validateManifestShape` (schema 2 only), `bundleEntry`, `findBlobEntry`, `isSha256Hex`.
- `release.ts` (rewrite) — `ArchiveFile` (moved from `archive.ts`), `buildReleaseV2`, `verifyReleaseV2`, `blobAad`, `collectBlobShas`, `totalBlobBytes`.
- `archive.ts` (delete) — SOA1 is gone.
- `protocol.ts` (modify) — `CheckRequestV2`; route comments to `/ota/v2`.
- `index.ts` (modify) — exports.
- `selftest.ts` (rewrite) — async checks over a v2 fixture.
- `package.json` — dependency `@mongodb-js/zstd`, version 0.3.0 (Task 13).

**packages/backend/src**
- `http.ts` (rewrite) — `PUT`, `:param` routes, `stream: true` routes with `ctx.bodyStream`, `parseRangeHeader`, `binaryStream(..., headers)`.
- `http.test.ts` (new) — router unit checks (`npm run test:http`).
- `providers.ts` (modify) — `BlobStore` v2 (keys, ranges, delete, prefix delete, stream put), `CacheProvider.getToken`, `DatabaseProvider` retired-client counters, `ReleaseRecord` v2 fields, `releaseBlobKey` / `releaseBlobPrefix`, Disk/Memory implementations.
- `providers.test.ts` (new) — Disk/Memory provider checks (`npm run test:providers`).
- `adapters/s3-blob.ts`, `adapters/sqlite-db.ts`, `adapters/postgres-db.ts`, `adapters/redis-cache.ts` (modify) + their tests.
- `upload.ts` (new) — `spoolToTemp` (hash + count + cap while streaming), `drain`.
- `config.ts` (modify) — `maxBlobBytes`, new TTL default.
- `store.ts` (modify) — `createRelease`, `missingBlobs`, `stageBlob`, `finalizeRelease`, `statBlob`, `openBlobStream`, reusable download tokens, retired-client counters, `pickEligible` finalized gate.
- `store.test.ts` (new) — store checks over the disk providers (`npm run test:store`).
- `routes.ts` (modify) — v2 device routes, blob GET with Range, three-step admin publish, tombstones, richer `/admin/releases`.
- `express.ts` (modify) — matcher + streaming bodies.
- `index.ts` (modify) — exports.
- `e2e.test.ts` (rewrite), `express.smoke.test.ts` (rewrite), `examples/express-server.ts` (touch).

**Root** `package.json` — new `test:http`, `test:providers`, `test:store` scripts folded into `test`.

**website/docs** — `architecture/manifest-schema.md`, `architecture/blobs.md` (replaces `soa1-archive.md`), `backend/endpoints.md`, `backend/store.md`, `backend/providers.md`, `backend/express.md`, `backend/configuration.md`, `security/limitations.md`, `security/threat-model.md`, `api/shared.md`, `packages/backend/README.md`.

---

### Task 1: Path rules (`validatePath`) + async self-test harness

**Files:**
- Create: `packages/shared/src/paths.ts`
- Modify: `packages/shared/src/index.ts`
- Modify: `packages/shared/src/selftest.ts`

**Interfaces:**
- Produces: `export const MAX_PATH_BYTES = 512` and `export function validatePath(path: unknown): string | null` — returns `null` when valid, else one of the exact strings `'path is empty'`, `'path exceeds 512 bytes'`, `'path contains NUL'`, `'path must use POSIX separators'`, `'path must be relative'`, `'path has an empty segment'`, `'path has a dot segment'` (checked in that order). Consumed by Task 4 (manifest validation, `buildReleaseV2`) and Task 9 (publish rejects bad paths).

- [ ] **Step 1: Make the self-test harness async (mechanical edit)**

In `packages/shared/src/selftest.ts` replace the `check` helper:

```ts
let passed = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}
```

Then wrap the run in `main()`: replace the line `console.log('dash-ota core self-test\n');` with

```ts
async function main(): Promise<void> {
  console.log('dash-ota core self-test\n');
```

replace the final `console.log(`\n${passed} checks passed.`);` with

```ts
  console.log(`\n${passed} checks passed.`);
}

void main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
```

and prefix every top-level `check(` call with `await `:

```bash
cd packages/shared/src && sed -i '' 's/^check(/await check(/' selftest.ts && cd - && npx prettier --write packages/shared/src/selftest.ts
```

Run: `npm run test:core` — Expected: the 14 existing checks still pass (`14 checks passed.`).

- [ ] **Step 2: Write the failing test**

Append to the end of `main()` in `selftest.ts` (before the closing `console.log`), and add `validatePath` to the `./index.js` import list:

```ts
  await check('validatePath accepts normal relative POSIX paths', () => {
    assert.equal(validatePath('index.android.bundle'), null);
    assert.equal(validatePath('drawable-xxhdpi/src_assets_images_logo.png'), null);
    assert.equal(validatePath('assets/src/assets/images/logo@2x.png'), null);
  });

  await check('validatePath rejects every spec rule with a stable message', () => {
    assert.equal(validatePath(''), 'path is empty');
    assert.equal(validatePath(undefined), 'path is empty');
    assert.equal(validatePath('/abs/file'), 'path must be relative');
    assert.equal(validatePath('a//b'), 'path has an empty segment');
    assert.equal(validatePath('a/b/'), 'path has an empty segment');
    assert.equal(validatePath('../x'), 'path has a dot segment');
    assert.equal(validatePath('a/./b'), 'path has a dot segment');
    assert.equal(validatePath('a\\b'), 'path must use POSIX separators');
    assert.equal(validatePath('a\0b'), 'path contains NUL');
    assert.equal(validatePath(`a/${'x'.repeat(512)}`), 'path exceeds 512 bytes');
  });
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm run test:core`
Expected: FAIL — `SyntaxError: The requested module './index.js' does not provide an export named 'validatePath'`.

- [ ] **Step 4: Implement `paths.ts` and export it**

`packages/shared/src/paths.ts`:

```ts
/**
 * Path rules for manifest file entries. A manifest path is written to disk verbatim under the
 * slot directory by the device, so the rules are the trust boundary against traversal: relative,
 * POSIX separators, no empty or dot segments, no NUL, bounded length. The same function runs at
 * build time (CLI), ingest time (backend) and — re-implemented — on device.
 *
 * @module paths
 */

/** Maximum UTF-8 length of a manifest path. */
export const MAX_PATH_BYTES = 512;

/**
 * Validate a manifest file path.
 * @param path untrusted value
 * @returns `null` when valid, else a short reason (stable strings — tests and error codes depend on them)
 */
export function validatePath(path: unknown): string | null {
  if (typeof path !== 'string' || path.length === 0) return 'path is empty';
  if (Buffer.byteLength(path, 'utf8') > MAX_PATH_BYTES) return `path exceeds ${MAX_PATH_BYTES} bytes`;
  if (path.includes('\0')) return 'path contains NUL';
  if (path.includes('\\')) return 'path must use POSIX separators';
  if (path.startsWith('/')) return 'path must be relative';
  for (const segment of path.split('/')) {
    if (segment === '') return 'path has an empty segment';
    if (segment === '.' || segment === '..') return 'path has a dot segment';
  }
  return null;
}
```

In `packages/shared/src/index.ts` add (keep the existing lines):

```ts
export * from './paths.js';
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm run test:core && npx tsc -p packages/shared`
Expected: `16 checks passed.` and no type errors.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/paths.ts packages/shared/src/index.ts packages/shared/src/selftest.ts
git commit -m "feat(shared): manifest path rules (validatePath) and an async self-test harness"
```

---

### Task 2: Per-blob zstd compression module

**Files:**
- Create: `packages/shared/src/compression.ts`
- Modify: `packages/shared/package.json` (dependency), `package-lock.json`
- Modify: `packages/shared/src/index.ts`, `packages/shared/src/selftest.ts`

**Interfaces:**
- Produces:
  - `export type BlobCompression = 'zstd' | 'none'`
  - `export const NO_COMPRESS_EXTENSIONS: ReadonlySet<string>`, `DEFAULT_BUNDLE_ZSTD_LEVEL = 19`, `DEFAULT_ASSET_ZSTD_LEVEL = 3`, `COMPRESS_MIN_GAIN = 0.02`
  - `export function isCompressibleExtension(path: string): boolean`
  - `export async function zstdCompress(data: Buffer, level: number): Promise<Buffer>`
  - `export async function zstdDecompress(data: Buffer): Promise<Buffer>`
  - `export interface CompressedBlob { data: Buffer; compression: BlobCompression }`
  - `export async function compressForBlob(path: string, data: Buffer, level: number): Promise<CompressedBlob>`
- Consumed by Task 4 (`buildReleaseV2` / `verifyReleaseV2`) and, via `BlobCompression`, by the manifest types.

- [ ] **Step 1: Add the dependency**

```bash
npm i -w @dash-ota/shared @mongodb-js/zstd@^7.0.0
node -e "import('@mongodb-js/zstd').then((m) => m.compress(Buffer.from('a'.repeat(1000)), 3)).then((b) => console.log('zstd ok, bytes:', b.length))"
```

Expected: `zstd ok, bytes: <number well under 1000>` (the prebuilt addon downloaded via `prebuild-install`; needs network once).

- [ ] **Step 2: Write the failing test**

Append inside `main()` in `selftest.ts`; add `import { randomBytes } from 'node:crypto';` at the top and add `compressForBlob, isCompressibleExtension, zstdCompress, zstdDecompress` to the `./index.js` import:

```ts
  await check('zstd round-trips and compressForBlob honours the skip rules', async () => {
    const text = Buffer.from('function f(){return 1}\n'.repeat(400), 'utf8');
    const packed = await zstdCompress(text, 19);
    assert.ok(packed.length < text.length / 4, 'expected strong compression on repetitive text');
    assert.deepEqual(await zstdDecompress(packed), text);

    const bundle = await compressForBlob('index.android.bundle', text, 19);
    assert.equal(bundle.compression, 'zstd');
    assert.ok(bundle.data.length < text.length);

    const png = await compressForBlob('drawable-mdpi/logo.png', text, 3);
    assert.equal(png.compression, 'none');
    assert.equal(png.data, text);

    const random = randomBytes(4096);
    const dense = await compressForBlob('assets/blob.bin', random, 3);
    assert.equal(dense.compression, 'none', 'incompressible data must ship uncompressed (>= 98% rule)');
    assert.equal(dense.data, random);

    assert.equal(isCompressibleExtension('fonts/Inter.WOFF2'), false);
    assert.equal(isCompressibleExtension('index.android.bundle'), true);
    assert.equal(isCompressibleExtension('noext'), true);
    assert.equal(isCompressibleExtension('dir.png/file'), true);
  });
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm run test:core`
Expected: FAIL — `does not provide an export named 'compressForBlob'`.

- [ ] **Step 4: Implement `compression.ts` and export it**

```ts
/**
 * Per-blob compression for protocol v2. Every manifest file is stored as its own blob; the
 * Hermes bytecode compresses ~3.6× with zstd, assets that are already dense (PNG, fonts, media)
 * ship as-is. Uses `@mongodb-js/zstd` (prebuilt native addon, async API) — the device side
 * decodes with zstd-jni / libzstd.
 *
 * @module compression
 */

import { compress, decompress } from '@mongodb-js/zstd';

/** How a blob's bytes were transformed before (optional) encryption. */
export type BlobCompression = 'zstd' | 'none';

/** File extensions that never gain from zstd (already compressed formats). Lower-case, no dot. */
export const NO_COMPRESS_EXTENSIONS: ReadonlySet<string> = new Set([
  'png', 'jpg', 'jpeg', 'webp', 'gif', 'mp4', 'm4a', 'mp3', 'zip', 'gz', 'zst', 'woff', 'woff2',
]);

/** zstd level for the `role: "bundle"` entry (bytecode; compressed once, downloaded many times). */
export const DEFAULT_BUNDLE_ZSTD_LEVEL = 19;
/** zstd level for every other file. */
export const DEFAULT_ASSET_ZSTD_LEVEL = 3;
/** Compression is kept only when it saves at least this fraction (output < 98 % of input). */
export const COMPRESS_MIN_GAIN = 0.02;

/** True unless the path's extension is in {@link NO_COMPRESS_EXTENSIONS}. */
export function isCompressibleExtension(path: string): boolean {
  const dot = path.lastIndexOf('.');
  const slash = path.lastIndexOf('/');
  if (dot === -1 || dot < slash) return true;
  return !NO_COMPRESS_EXTENSIONS.has(path.slice(dot + 1).toLowerCase());
}

/** zstd-compress a buffer at `level`. */
export async function zstdCompress(data: Buffer, level: number): Promise<Buffer> {
  return compress(data, level);
}

/** Inflate a zstd frame produced by {@link zstdCompress}. */
export async function zstdDecompress(data: Buffer): Promise<Buffer> {
  return decompress(data);
}

/** The stored form of a file plus how it was transformed. */
export interface CompressedBlob {
  data: Buffer;
  compression: BlobCompression;
}

/**
 * Compress a file for storage unless the extension is on the skip list or the gain is below
 * {@link COMPRESS_MIN_GAIN}; in both cases the original bytes are returned with `compression: 'none'`.
 * @param path manifest path (only the extension is looked at)
 * @param data plaintext bytes
 * @param level zstd level
 */
export async function compressForBlob(path: string, data: Buffer, level: number): Promise<CompressedBlob> {
  if (data.length === 0 || !isCompressibleExtension(path)) return { data, compression: 'none' };
  const packed = await zstdCompress(data, level);
  if (packed.length >= Math.ceil(data.length * (1 - COMPRESS_MIN_GAIN))) return { data, compression: 'none' };
  return { data: packed, compression: 'zstd' };
}
```

In `index.ts` add `export * from './compression.js';`.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm run test:core && npx tsc -p packages/shared`
Expected: `17 checks passed.`, no type errors.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/package.json package-lock.json packages/shared/src/compression.ts packages/shared/src/index.ts packages/shared/src/selftest.ts
git commit -m "feat(shared): zstd blob compression with skip-list and minimum-gain rule"
```

---

### Task 3: AES-GCM additional authenticated data

**Files:**
- Modify: `packages/shared/src/crypto.ts:127-153`
- Modify: `packages/shared/src/selftest.ts`

**Interfaces:**
- Produces: `aesGcmEncrypt(key: Buffer, plaintext: Buffer, aad?: Buffer): AesGcmResult` and `aesGcmDecrypt(key: Buffer, ivB64: string, ciphertext: Buffer, tagB64: string, aad?: Buffer): Buffer`. Existing callers (no `aad`) are unchanged. Consumed by Task 4 (`blobAad`).

- [ ] **Step 1: Write the failing test**

Append inside `main()` in `selftest.ts`:

```ts
  await check('AES-GCM binds additional authenticated data (AAD)', () => {
    const key = randomAesKey();
    const aad = Buffer.from('bnd_1/abc', 'utf8');
    const enc = aesGcmEncrypt(key, Buffer.from('payload'), aad);
    assert.deepEqual(aesGcmDecrypt(key, enc.ivB64, enc.ciphertext, enc.tagB64, aad), Buffer.from('payload'));
    assert.throws(() => aesGcmDecrypt(key, enc.ivB64, enc.ciphertext, enc.tagB64, Buffer.from('bnd_2/abc', 'utf8')));
    assert.throws(() => aesGcmDecrypt(key, enc.ivB64, enc.ciphertext, enc.tagB64));
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test:core`
Expected: FAIL at this check — decrypt with the wrong/missing AAD does **not** throw yet (the extra argument is ignored), so `assert.throws` fails with `Missing expected exception`.

- [ ] **Step 3: Implement**

In `crypto.ts` change the two functions (JSDoc `@param aad` added to each):

```ts
export function aesGcmEncrypt(key: Buffer, plaintext: Buffer, aad?: Buffer): AesGcmResult {
  if (key.length !== 32) throw new Error('aesGcmEncrypt: key must be 32 bytes');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  if (aad) cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { ivB64: iv.toString('base64'), ciphertext, tagB64: cipher.getAuthTag().toString('base64') };
}

export function aesGcmDecrypt(key: Buffer, ivB64: string, ciphertext: Buffer, tagB64: string, aad?: Buffer): Buffer {
  if (key.length !== 32) throw new Error('aesGcmDecrypt: key must be 32 bytes');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
  if (aad) decipher.setAAD(aad);
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test:core` — Expected: `18 checks passed.`

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/crypto.ts packages/shared/src/selftest.ts
git commit -m "feat(shared): optional AAD on AES-GCM encrypt/decrypt"
```

---

### Task 4: Wire format v2 — manifest types, validation, `buildReleaseV2`, `verifyReleaseV2`

**Files:**
- Rewrite: `packages/shared/src/manifest.ts`
- Rewrite: `packages/shared/src/release.ts`
- Delete: `packages/shared/src/archive.ts`
- Modify: `packages/shared/src/protocol.ts`, `packages/shared/src/index.ts`
- Rewrite: `packages/shared/src/selftest.ts`

**Interfaces:**
- Consumes: `validatePath` (Task 1), `compressForBlob` / `zstdDecompress` / `BlobCompression` (Task 2), `aesGcmEncrypt` / `aesGcmDecrypt` with `aad` (Task 3).
- Produces (all exported from `@dash-ota/shared`):
  - `MANIFEST_SCHEMA = 2`, `OTA_PROTOCOL = 2`, `SHA256_HEX: RegExp`, `isSha256Hex(v: unknown): v is string`
  - `interface BlobEntry { sha256: string; size: number; compression: BlobCompression; ivB64?: string; tagB64?: string }`
  - `interface FileEntryV2 { path: string; role?: 'bundle'; sha256: string; size: number; blob: BlobEntry }`
  - `type PatchCompression = 'zstd-patch'`; `interface PatchBlobEntry { sha256; size; compression: PatchCompression; ivB64?; tagB64? }`; `interface PatchEntry { baseSha256: string; blob: PatchBlobEntry }`
  - `type EncryptionV2 = { mode: 'none' } | { mode: 'aes-256-gcm'; contentKeyB64: string }`
  - `interface ManifestV2 { schema: 2; protocol: 2; bundleId; runtimeVersion; bundleVersion; platform; channel; appId; createdAt; mandatory; minNativeBuild?; targetAppVersions?; encryption: EncryptionV2; files: FileEntryV2[]; patches: PatchEntry[]; releaseNotes?; keyId }`; `type Manifest = ManifestV2` (so `SignedManifest`, `isEligible`, `targeting.ts` compile unchanged)
  - `bundleEntry(m: ManifestV2): FileEntryV2 | undefined`; `findBlobEntry(m: ManifestV2, blobSha256: string): BlobEntry | PatchBlobEntry | undefined`
  - `validateManifestShape(value: unknown): string[]` — schema-2 rules (see code)
  - `interface ArchiveFile { path: string; data: Buffer }`
  - `interface BuildReleaseV2Input { bundleId; runtimeVersion; bundleVersion; platform; channel; appId; mandatory; files: ArchiveFile[]; bundlePath: string; keyId; encrypt?: boolean (default true); bundleCompressionLevel?; assetCompressionLevel?; targetAppVersions?; minNativeBuild?; releaseNotes? }`
  - `interface BuiltReleaseV2 { manifest: ManifestV2; blobs: Map<string, Buffer>; contentKey: Buffer | null }` — **`buildReleaseV2(input): Promise<BuiltReleaseV2>` is async** (zstd is async)
  - `type BlobFetcher = (blobSha256: string) => Promise<Buffer>`; `interface VerifiedReleaseV2 { files: ArchiveFile[] }`; **`verifyReleaseV2(signed, fetchBlob, trustedPublicKey): Promise<VerifiedReleaseV2>` is async**
  - `blobAad(bundleId, fileSha256): Buffer`, `collectBlobShas(m): string[]` (unique, files + patches), `totalBlobBytes(m): number` (unique blobs)
  - `interface CheckRequestV2 extends CheckRequest { protocol: 2; currentBundleId: string; currentBundleSha256: string }`
- Removed: `buildRelease`, `openRelease`, `BuildReleaseInput`, `BuiltRelease`, `packArchive`, `unpackArchive`, `FileEntry`, `ManifestEncryption`.

- [ ] **Step 1: Replace `selftest.ts` with the v2 suite (this is the failing test)**

Write the whole file:

```ts
/**
 * Self-test for the crypto/protocol core. Proves the security guarantees the whole system
 * rests on, with no server or device needed. Run: `npm run test:core`.
 *
 * @module selftest
 */

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
  aesGcmDecrypt,
  aesGcmEncrypt,
  buildReleaseV2,
  canonicalize,
  compressForBlob,
  computeRuntimeVersion,
  constantTimeEqualHex,
  generateSigningKeyPair,
  hmacSha256Hex,
  isCompressibleExtension,
  isEligible,
  type ManifestV2,
  publicKeyFromRawB64,
  randomAesKey,
  rolloutBucket,
  satisfiesAppVersionRange,
  sha256Hex,
  signManifest,
  validateManifestShape,
  validatePath,
  verifyManifest,
  verifyReleaseV2,
  zstdCompress,
  zstdDecompress,
} from './index.js';

let passed = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const BUNDLE = Buffer.from('console.log("hello from OTA bundle");\n'.repeat(50), 'utf8');
const LOGO = Buffer.from('LOGO-BYTES', 'utf8');

/** Build + sign a two-file v2 release (bytecode + png) with a fresh key. */
async function makeSignedBundle(overrides: Partial<ManifestV2> = {}, encrypt = true) {
  const { privateKeyPem, publicKeyRawB64 } = generateSigningKeyPair();
  const built = await buildReleaseV2({
    bundleId: 'bnd_test_1',
    runtimeVersion: 'rt_v1',
    bundleVersion: 2,
    platform: 'android',
    channel: 'dev',
    appId: 'com.example.app',
    mandatory: false,
    keyId: 'key_dev_1',
    bundlePath: 'index.android.bundle',
    encrypt,
    files: [
      { path: 'index.android.bundle', data: BUNDLE },
      { path: 'drawable-mdpi/logo.png', data: LOGO },
    ],
  });
  const manifest: ManifestV2 = { ...built.manifest, ...overrides };
  const signed = signManifest(manifest, privateKeyPem);
  return { signed, privateKeyPem, publicKeyRawB64, blobs: built.blobs };
}

async function main(): Promise<void> {
  console.log('dash-ota core self-test\n');

  await check('canonicalize is key-order independent', () => {
    assert.equal(canonicalize({ b: 1, a: { d: 4, c: 3 } }), canonicalize({ a: { c: 3, d: 4 }, b: 1 }));
    assert.equal(canonicalize({ a: 2, b: 1 }), '{"a":2,"b":1}');
  });

  await check('validatePath accepts normal relative POSIX paths', () => {
    assert.equal(validatePath('index.android.bundle'), null);
    assert.equal(validatePath('drawable-xxhdpi/src_assets_images_logo.png'), null);
    assert.equal(validatePath('assets/src/assets/images/logo@2x.png'), null);
  });

  await check('validatePath rejects every spec rule with a stable message', () => {
    assert.equal(validatePath(''), 'path is empty');
    assert.equal(validatePath(undefined), 'path is empty');
    assert.equal(validatePath('/abs/file'), 'path must be relative');
    assert.equal(validatePath('a//b'), 'path has an empty segment');
    assert.equal(validatePath('a/b/'), 'path has an empty segment');
    assert.equal(validatePath('../x'), 'path has a dot segment');
    assert.equal(validatePath('a/./b'), 'path has a dot segment');
    assert.equal(validatePath('a\\b'), 'path must use POSIX separators');
    assert.equal(validatePath('a\0b'), 'path contains NUL');
    assert.equal(validatePath(`a/${'x'.repeat(512)}`), 'path exceeds 512 bytes');
  });

  await check('zstd round-trips and compressForBlob honours the skip rules', async () => {
    const text = Buffer.from('function f(){return 1}\n'.repeat(400), 'utf8');
    const packed = await zstdCompress(text, 19);
    assert.ok(packed.length < text.length / 4, 'expected strong compression on repetitive text');
    assert.deepEqual(await zstdDecompress(packed), text);
    const bundle = await compressForBlob('index.android.bundle', text, 19);
    assert.equal(bundle.compression, 'zstd');
    const png = await compressForBlob('drawable-mdpi/logo.png', text, 3);
    assert.equal(png.compression, 'none');
    assert.equal(png.data, text);
    const random = randomBytes(4096);
    const dense = await compressForBlob('assets/blob.bin', random, 3);
    assert.equal(dense.compression, 'none', 'incompressible data must ship uncompressed (>= 98% rule)');
    assert.equal(isCompressibleExtension('fonts/Inter.WOFF2'), false);
    assert.equal(isCompressibleExtension('noext'), true);
  });

  await check('AES-GCM binds additional authenticated data (AAD)', () => {
    const key = randomAesKey();
    const aad = Buffer.from('bnd_1/abc', 'utf8');
    const enc = aesGcmEncrypt(key, Buffer.from('payload'), aad);
    assert.deepEqual(aesGcmDecrypt(key, enc.ivB64, enc.ciphertext, enc.tagB64, aad), Buffer.from('payload'));
    assert.throws(() => aesGcmDecrypt(key, enc.ivB64, enc.ciphertext, enc.tagB64, Buffer.from('bnd_2/abc', 'utf8')));
    assert.throws(() => aesGcmDecrypt(key, enc.ivB64, enc.ciphertext, enc.tagB64));
  });

  await check('Ed25519 sign → verify with embedded raw public key', async () => {
    const { signed, publicKeyRawB64 } = await makeSignedBundle();
    assert.equal(verifyManifest(signed, publicKeyFromRawB64(publicKeyRawB64)), true);
  });

  await check('tampered manifest fails verification (integrity / anti-injection)', async () => {
    const { signed, publicKeyRawB64 } = await makeSignedBundle();
    const tampered = { ...signed, manifest: { ...signed.manifest, bundleVersion: 999 } };
    assert.equal(verifyManifest(tampered, publicKeyFromRawB64(publicKeyRawB64)), false);
  });

  await check('signature from a different key is rejected (forgery)', async () => {
    const { signed } = await makeSignedBundle();
    const attacker = generateSigningKeyPair();
    assert.equal(verifyManifest(signed, publicKeyFromRawB64(attacker.publicKeyRawB64)), false);
  });

  await check('buildReleaseV2 emits schema 2 with one bundle entry, zstd bytecode, raw png', async () => {
    const { signed } = await makeSignedBundle();
    const m = signed.manifest;
    assert.equal(m.schema, 2);
    assert.equal(m.protocol, 2);
    assert.equal(m.appId, 'com.example.app');
    assert.equal(m.encryption.mode, 'aes-256-gcm');
    assert.deepEqual(m.patches, []);
    const bundle = m.files.find((f) => f.role === 'bundle');
    assert.equal(bundle?.path, 'index.android.bundle');
    assert.equal(bundle?.sha256, sha256Hex(BUNDLE));
    assert.equal(bundle?.size, BUNDLE.length);
    assert.equal(bundle?.blob.compression, 'zstd');
    assert.ok((bundle?.blob.size ?? Infinity) < BUNDLE.length);
    assert.equal(Buffer.from(bundle?.blob.ivB64 ?? '', 'base64').length, 12);
    assert.equal(Buffer.from(bundle?.blob.tagB64 ?? '', 'base64').length, 16);
    const png = m.files.find((f) => f.path === 'drawable-mdpi/logo.png');
    assert.equal(png?.role, undefined);
    assert.equal(png?.blob.compression, 'none');
    assert.equal(png?.blob.size, LOGO.length, 'GCM adds no length; the tag lives in the manifest');
  });

  await check('verifyReleaseV2 recovers every file from the blobs (encrypted)', async () => {
    const { signed, publicKeyRawB64, blobs } = await makeSignedBundle();
    const fetched: string[] = [];
    const { files } = await verifyReleaseV2(
      signed,
      async (sha) => {
        fetched.push(sha);
        const b = blobs.get(sha);
        if (!b) throw new Error(`missing blob ${sha}`);
        return b;
      },
      publicKeyFromRawB64(publicKeyRawB64),
    );
    assert.deepEqual(files.find((f) => f.path === 'index.android.bundle')?.data, BUNDLE);
    assert.deepEqual(files.find((f) => f.path === 'drawable-mdpi/logo.png')?.data, LOGO);
    assert.equal(fetched.length, 2);
  });

  await check('verifyReleaseV2 works with encryption.mode none', async () => {
    const { signed, publicKeyRawB64, blobs } = await makeSignedBundle({}, false);
    assert.equal(signed.manifest.encryption.mode, 'none');
    assert.equal(signed.manifest.files[0]?.blob.ivB64, undefined);
    const { files } = await verifyReleaseV2(signed, async (sha) => blobs.get(sha)!, publicKeyFromRawB64(publicKeyRawB64));
    assert.deepEqual(files.find((f) => f.path === 'index.android.bundle')?.data, BUNDLE);
  });

  await check('a tampered blob is rejected on the stored-bytes hash', async () => {
    const { signed, publicKeyRawB64, blobs } = await makeSignedBundle();
    const flipped = new Map(blobs);
    const [sha, bytes] = [...blobs.entries()][0]!;
    const copy = Buffer.from(bytes);
    copy[0] = (copy[0] ?? 0) ^ 0xff;
    flipped.set(sha, copy);
    await assert.rejects(
      verifyReleaseV2(signed, async (s) => flipped.get(s)!, publicKeyFromRawB64(publicKeyRawB64)),
      /blob hash mismatch/,
    );
  });

  await check('a blob re-used under another bundleId fails AAD (validly re-signed manifest)', async () => {
    const { signed, privateKeyPem, publicKeyRawB64, blobs } = await makeSignedBundle();
    const moved = signManifest({ ...signed.manifest, bundleId: 'bnd_other' }, privateKeyPem);
    await assert.rejects(
      verifyReleaseV2(moved, async (s) => blobs.get(s)!, publicKeyFromRawB64(publicKeyRawB64)),
      /Unsupported state|unable to authenticate/,
    );
  });

  await check('a wrong plaintext claim is rejected after decompression (mode none)', async () => {
    const { signed, privateKeyPem, publicKeyRawB64, blobs } = await makeSignedBundle({}, false);
    const files = signed.manifest.files.map((f) => (f.role === 'bundle' ? { ...f, sha256: 'a'.repeat(64) } : f));
    const lying = signManifest({ ...signed.manifest, files }, privateKeyPem);
    await assert.rejects(
      verifyReleaseV2(lying, async (s) => blobs.get(s)!, publicKeyFromRawB64(publicKeyRawB64)),
      /hash mismatch index.android.bundle/,
    );
  });

  await check('buildReleaseV2 refuses a bad path or a missing bundlePath', async () => {
    const base = {
      bundleId: 'b',
      runtimeVersion: 'r',
      bundleVersion: 1,
      platform: 'ios' as const,
      channel: 'dev' as const,
      appId: 'com.example.app',
      mandatory: false,
      keyId: 'k',
    };
    await assert.rejects(
      buildReleaseV2({ ...base, bundlePath: 'main.jsbundle', files: [{ path: '../main.jsbundle', data: BUNDLE }] }),
      /dot segment/,
    );
    await assert.rejects(
      buildReleaseV2({ ...base, bundlePath: 'main.jsbundle', files: [{ path: 'other.js', data: BUNDLE }] }),
      /bundlePath main.jsbundle is not among the files/,
    );
  });

  await check('manifest shape validation enforces the v2 rules', async () => {
    const { signed } = await makeSignedBundle();
    const m = signed.manifest;
    assert.deepEqual(validateManifestShape(m), []);
    assert.ok(validateManifestShape({ ...m, schema: 1 }).includes('schema must be 2'));
    assert.ok(validateManifestShape({ ...m, protocol: 1 }).includes('protocol must be 2'));
    assert.ok(validateManifestShape({ ...m, appId: '' }).includes('appId is required'));
    assert.ok(validateManifestShape({ ...m, patches: undefined }).some((e) => e.includes('patches must be an array')));
    assert.ok(
      validateManifestShape({ ...m, files: m.files.map((f) => ({ ...f, role: undefined })) }).some((e) =>
        e.includes('exactly one file must have role "bundle"'),
      ),
    );
    assert.ok(
      validateManifestShape({ ...m, files: m.files.map((f) => ({ ...f, role: 'bundle' })) }).some((e) =>
        e.includes('exactly one file must have role "bundle" (found 2)'),
      ),
    );
    assert.ok(
      validateManifestShape({ ...m, files: [{ ...m.files[0]!, path: '../evil' }, m.files[1]!] }).some((e) =>
        e.includes('dot segment'),
      ),
    );
    assert.ok(
      validateManifestShape({ ...m, files: [m.files[0]!, { ...m.files[1]!, path: m.files[0]!.path }] }).some((e) =>
        e.includes('duplicates'),
      ),
    );
    assert.ok(
      validateManifestShape({ ...m, encryption: { mode: 'none' } }).some((e) => e.includes('must not carry ivB64/tagB64')),
    );
    assert.ok(validateManifestShape({ ...m, encryption: { mode: 'rot13' } }).some((e) => e.includes('encryption.mode')));
    assert.ok(
      validateManifestShape({ ...m, encryption: { mode: 'aes-256-gcm', contentKeyB64: 'c2hvcnQ=' } }).some((e) =>
        e.includes('32-byte'),
      ),
    );
    assert.ok(validateManifestShape({ schema: 2 }).length > 5);
  });

  await check('per-file sha256 detects a swapped asset', async () => {
    const { signed } = await makeSignedBundle();
    const fileHash = signed.manifest.files.find((f) => f.role === 'bundle')?.sha256;
    assert.equal(fileHash, sha256Hex(BUNDLE));
    assert.notEqual(fileHash, sha256Hex(Buffer.from('malicious', 'utf8')));
  });

  await check('HMAC-SHA256 primitive is deterministic + constant-time compared', () => {
    const key = Buffer.from('mac-key').toString('base64');
    const a = hmacSha256Hex(key, 'POST/ota/v2/check|nonce|123');
    const b = hmacSha256Hex(key, 'POST/ota/v2/check|nonce|123');
    assert.equal(constantTimeEqualHex(a, b), true);
    assert.equal(constantTimeEqualHex(a, hmacSha256Hex(key, 'tampered')), false);
  });

  await check('eligibility: runtimeVersion gate blocks cross-generation OTA (the store-vs-OTA bug)', async () => {
    const { signed } = await makeSignedBundle({ runtimeVersion: 'R2', bundleVersion: 5 });
    const r1Device = {
      platform: 'android' as const,
      channel: 'dev' as const,
      runtimeVersion: 'R1',
      appVersion: '1.0.0',
      buildNumber: 1,
      currentBundleVersion: 0,
      installId: 'install-A',
    };
    assert.deepEqual(isEligible(signed.manifest, r1Device), { eligible: false, reason: 'runtime-mismatch' });
    assert.equal(isEligible(signed.manifest, { ...r1Device, runtimeVersion: 'R2' }).eligible, true);
  });

  await check('eligibility: downgrade guard + app-version range', async () => {
    const { signed } = await makeSignedBundle({ runtimeVersion: 'R2', bundleVersion: 3, targetAppVersions: '>=1.2.0 <1.3.0' });
    const base = {
      platform: 'android' as const,
      channel: 'dev' as const,
      runtimeVersion: 'R2',
      appVersion: '1.2.5',
      buildNumber: 10,
      currentBundleVersion: 3,
      installId: 'install-A',
    };
    assert.equal(isEligible(signed.manifest, base).reason, 'not-newer');
    assert.equal(isEligible(signed.manifest, { ...base, currentBundleVersion: 2 }).eligible, true);
    assert.equal(
      isEligible(signed.manifest, { ...base, currentBundleVersion: 2, appVersion: '1.3.1' }).reason,
      'app-version-excluded',
    );
  });

  await check('semver-subset range matching', () => {
    assert.equal(satisfiesAppVersionRange('1.2.5', '>=1.2.0 <1.3.0'), true);
    assert.equal(satisfiesAppVersionRange('1.3.0', '>=1.2.0 <1.3.0'), false);
    assert.equal(satisfiesAppVersionRange('1.2.9', '1.2.x'), true);
    assert.equal(satisfiesAppVersionRange('1.4.0', '1.2.x'), false);
    assert.equal(satisfiesAppVersionRange('9.9.9', '*'), true);
  });

  await check('rollout bucket is deterministic and in range', () => {
    const a = rolloutBucket('install-A', 'bnd_1');
    assert.equal(a, rolloutBucket('install-A', 'bnd_1'));
    assert.ok(a >= 0 && a < 100);
  });

  await check('runtimeVersion fingerprint: stable + changes on native input change', () => {
    const base = {
      nativeDependencies: ['react-native-reanimated@4.0.0', 'react-native-dash-ota@0.1.0'],
      nativeDirHashes: { android: 'aa', ios: 'bb' },
      hermesVersion: '0.12.0',
      reactNativeVersion: '0.79.2',
    };
    assert.equal(
      computeRuntimeVersion(base),
      computeRuntimeVersion({ ...base, nativeDependencies: [...base.nativeDependencies].reverse() }),
    );
    assert.notEqual(computeRuntimeVersion(base), computeRuntimeVersion({ ...base, hermesVersion: '0.13.0' }));
  });

  console.log(`\n${passed} checks passed.`);
}

void main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test:core`
Expected: FAIL — `does not provide an export named 'buildReleaseV2'`.

- [ ] **Step 3: Rewrite `manifest.ts`**

Replace the whole file:

```ts
/**
 * The OTA **manifest** (schema 2) — the signed source of truth for a release. The CLI builds and
 * Ed25519-signs it; the backend stores and serves it verbatim; the native client verifies the
 * signature against an embedded public key, then verifies every blob and every plaintext file
 * before applying. The signature covers the *canonical* bytes of the {@link ManifestV2} (not the
 * envelope), so `keyId`/`signatureB64` live outside the signed object.
 *
 * Every file is its own content-addressed blob: `files[].sha256`/`size` describe the plaintext
 * that lands on disk, `files[].blob` describes the stored bytes (compressed, then optionally
 * encrypted) the device downloads from `/ota/v2/releases/{bundleId}/blobs/{blob.sha256}`.
 *
 * @module manifest
 */

import { canonicalBytes } from './canonical.js';
import type { BlobCompression } from './compression.js';
import { type KeyObject, signEd25519, verifyEd25519 } from './crypto.js';
import { validatePath } from './paths.js';

export type Platform = 'ios' | 'android';
export type Channel = 'dev' | 'uat' | 'prod';

/** The only manifest schema this version of dash-ota reads or writes. */
export const MANIFEST_SCHEMA = 2 as const;
/** The device ↔ backend protocol version carried in the manifest and in `/check`. */
export const OTA_PROTOCOL = 2 as const;
/** Lowercase hex SHA-256. */
export const SHA256_HEX = /^[0-9a-f]{64}$/;

/** True for a lowercase 64-hex SHA-256 string. */
export function isSha256Hex(v: unknown): v is string {
  return typeof v === 'string' && SHA256_HEX.test(v);
}

/** The stored (downloadable) form of a file. */
export interface BlobEntry {
  /** SHA-256 of exactly the bytes `GET …/blobs/{sha256}` returns. */
  sha256: string;
  /** stored size in bytes. */
  size: number;
  /** transform applied before encryption. */
  compression: BlobCompression;
  /** base64 12-byte IV — present only when `encryption.mode` is `aes-256-gcm`. */
  ivB64?: string;
  /** base64 16-byte GCM tag — present only when `encryption.mode` is `aes-256-gcm`. */
  tagB64?: string;
}

/** One file in the payload, with its plaintext identity and its blob. */
export interface FileEntryV2 {
  /** path relative to the slot root, e.g. "index.android.bundle" or "drawable-mdpi/logo.png". */
  path: string;
  /** exactly one entry carries `role: "bundle"` — the Hermes bytecode / JS entry file. */
  role?: 'bundle';
  /** lowercase hex SHA-256 of the **plaintext** bytes. */
  sha256: string;
  /** plaintext size in bytes. */
  size: number;
  blob: BlobEntry;
}

/** A bytecode patch blob (M3): the stored form of a zstd `--patch-from` frame. */
export type PatchCompression = 'zstd-patch';
export interface PatchBlobEntry {
  sha256: string;
  size: number;
  compression: PatchCompression;
  ivB64?: string;
  tagB64?: string;
}
/** A patch that turns the bytecode with SHA-256 `baseSha256` into this release's bundle. */
export interface PatchEntry {
  baseSha256: string;
  blob: PatchBlobEntry;
}

/** Per-release blob encryption. The content key rides inside the signed manifest (over TLS). */
export type EncryptionV2 = { mode: 'none' } | { mode: 'aes-256-gcm'; contentKeyB64: string };

/** The signed payload. */
export interface ManifestV2 {
  schema: typeof MANIFEST_SCHEMA;
  protocol: typeof OTA_PROTOCOL;
  /** globally-unique id for this bundle/release. */
  bundleId: string;
  /** native-compatibility key — an OTA is only eligible for a binary with the same value. */
  runtimeVersion: string;
  /** monotonic counter within a runtimeVersion (downgrade guard). */
  bundleVersion: number;
  platform: Platform;
  channel: Channel;
  /** application id (Android package / iOS bundle identifier); verified natively. */
  appId: string;
  /** ISO-8601 creation time. */
  createdAt: string;
  /** whether the client must apply before continuing. */
  mandatory: boolean;
  /** optional: minimum native build number that may run this (force-update hint). */
  minNativeBuild?: number;
  /** optional: semver range over the app marketing version, e.g. ">=1.2.0 <1.3.0". */
  targetAppVersions?: string;
  encryption: EncryptionV2;
  /** every file in the payload; the device stages exactly this set. */
  files: FileEntryV2[];
  /** bytecode patches (empty until M3). */
  patches: PatchEntry[];
  /** optional human release notes (shown as in-app "What's New"). */
  releaseNotes?: string;
  /** id of the signing key, so the client can pick the right key from its key ring. */
  keyId: string;
}

/** The manifest shape in use. Kept as an alias so `SignedManifest` and targeting read naturally. */
export type Manifest = ManifestV2;

/** Signed envelope: the manifest plus its detached Ed25519 signature. */
export interface SignedManifest {
  manifest: Manifest;
  /** base64 Ed25519 signature over `canonicalBytes(manifest)`. */
  signatureB64: string;
  /** convenience copy of `manifest.keyId`. */
  keyId: string;
}

/**
 * Sign a manifest, producing the envelope the backend stores and serves.
 * @param manifest the manifest to sign
 * @param privateKeyPem PKCS#8 PEM private key (CLI/CI only)
 */
export function signManifest(manifest: Manifest, privateKeyPem: string): SignedManifest {
  const signature = signEd25519(privateKeyPem, canonicalBytes(manifest));
  return { manifest, signatureB64: signature.toString('base64'), keyId: manifest.keyId };
}

/**
 * Verify a signed manifest against a trusted public key.
 * @param signed the signed envelope
 * @param publicKey PEM string or KeyObject (from the app's embedded key ring)
 */
export function verifyManifest(signed: SignedManifest, publicKey: string | KeyObject): boolean {
  return verifyEd25519(publicKey, canonicalBytes(signed.manifest), Buffer.from(signed.signatureB64, 'base64'));
}

/** The `role: "bundle"` entry (the bytecode). */
export function bundleEntry(manifest: ManifestV2): FileEntryV2 | undefined {
  return manifest.files.find((f) => f.role === 'bundle');
}

/** Look up a blob (file or patch) by its stored-bytes hash. */
export function findBlobEntry(manifest: ManifestV2, blobSha256: string): BlobEntry | PatchBlobEntry | undefined {
  for (const f of manifest.files) if (f.blob.sha256 === blobSha256) return f.blob;
  for (const p of manifest.patches) if (p.blob.sha256 === blobSha256) return p.blob;
  return undefined;
}

/** True when `v` is a base64 string decoding to exactly `bytes` bytes. */
function isB64OfLength(v: unknown, bytes: number): boolean {
  return typeof v === 'string' && v.length > 0 && Buffer.from(v, 'base64').length === bytes;
}

function validateBlob(prefix: string, value: unknown, encrypted: boolean, kinds: readonly string[], errors: string[]): void {
  const blob = value as Partial<BlobEntry> | null;
  if (!blob || typeof blob !== 'object') {
    errors.push(`${prefix}.blob invalid`);
    return;
  }
  if (!isSha256Hex(blob.sha256)) errors.push(`${prefix}.blob.sha256 invalid`);
  if (!Number.isInteger(blob.size) || (blob.size as number) < 0) errors.push(`${prefix}.blob.size invalid`);
  if (!kinds.includes(blob.compression as string)) errors.push(`${prefix}.blob.compression must be ${kinds.join('|')}`);
  if (encrypted) {
    if (!isB64OfLength(blob.ivB64, 12)) errors.push(`${prefix}.blob.ivB64 must be a 12-byte base64 IV`);
    if (!isB64OfLength(blob.tagB64, 16)) errors.push(`${prefix}.blob.tagB64 must be a 16-byte base64 tag`);
  } else if (blob.ivB64 !== undefined || blob.tagB64 !== undefined) {
    errors.push(`${prefix}.blob must not carry ivB64/tagB64 when encryption.mode is none`);
  }
}

/**
 * Runtime shape validation for the trust boundary (backend ingest + native + CLI). Returns a
 * list of problems; empty means structurally valid. Not a substitute for the signature check.
 * @param value untrusted parsed JSON
 */
export function validateManifestShape(value: unknown): string[] {
  const errors: string[] = [];
  const m = value as Partial<ManifestV2> | null;
  if (!m || typeof m !== 'object') return ['manifest is not an object'];
  if (m.schema !== MANIFEST_SCHEMA) errors.push('schema must be 2');
  if (m.protocol !== OTA_PROTOCOL) errors.push('protocol must be 2');
  if (!m.bundleId) errors.push('bundleId is required');
  if (!m.runtimeVersion) errors.push('runtimeVersion is required');
  if (typeof m.bundleVersion !== 'number' || !Number.isInteger(m.bundleVersion)) errors.push('bundleVersion must be an integer');
  if (m.platform !== 'ios' && m.platform !== 'android') errors.push('platform must be ios|android');
  if (m.channel !== 'dev' && m.channel !== 'uat' && m.channel !== 'prod') errors.push('channel must be dev|uat|prod');
  if (typeof m.appId !== 'string' || m.appId.length === 0) errors.push('appId is required');
  if (typeof m.createdAt !== 'string' || m.createdAt.length === 0) errors.push('createdAt is required');
  if (typeof m.mandatory !== 'boolean') errors.push('mandatory must be a boolean');
  if (!m.keyId) errors.push('keyId is required');

  const enc = m.encryption as Partial<{ mode: string; contentKeyB64: string }> | undefined;
  let encrypted = false;
  if (!enc || typeof enc !== 'object') errors.push('encryption is required');
  else if (enc.mode === 'aes-256-gcm') {
    encrypted = true;
    if (!isB64OfLength(enc.contentKeyB64, 32)) errors.push('encryption.contentKeyB64 must be a 32-byte base64 key');
  } else if (enc.mode !== 'none') errors.push('encryption.mode must be none|aes-256-gcm');

  if (!Array.isArray(m.files) || m.files.length === 0) {
    errors.push('files must be a non-empty array');
  } else {
    const seenPaths = new Set<string>();
    let bundles = 0;
    m.files.forEach((f, i) => {
      const entry = f as Partial<FileEntryV2> | null;
      const prefix = `files[${i}]`;
      if (!entry || typeof entry !== 'object') {
        errors.push(`${prefix} invalid`);
        return;
      }
      const pathError = validatePath(entry.path);
      if (pathError) errors.push(`${prefix}.path: ${pathError}`);
      else if (seenPaths.has(entry.path as string)) errors.push(`${prefix}.path duplicates ${entry.path}`);
      else seenPaths.add(entry.path as string);
      if (entry.role !== undefined && entry.role !== 'bundle') errors.push(`${prefix}.role must be "bundle" when present`);
      if (entry.role === 'bundle') bundles += 1;
      if (!isSha256Hex(entry.sha256)) errors.push(`${prefix}.sha256 invalid`);
      if (!Number.isInteger(entry.size) || (entry.size as number) < 0) errors.push(`${prefix}.size invalid`);
      validateBlob(prefix, entry.blob, encrypted, ['zstd', 'none'], errors);
    });
    if (bundles !== 1) errors.push(`exactly one file must have role "bundle" (found ${bundles})`);
  }

  if (!Array.isArray(m.patches)) {
    errors.push('patches must be an array (may be empty)');
  } else {
    m.patches.forEach((p, i) => {
      const patch = p as Partial<PatchEntry> | null;
      const prefix = `patches[${i}]`;
      if (!patch || typeof patch !== 'object') {
        errors.push(`${prefix} invalid`);
        return;
      }
      if (!isSha256Hex(patch.baseSha256)) errors.push(`${prefix}.baseSha256 invalid`);
      validateBlob(prefix, patch.blob, encrypted, ['zstd-patch'], errors);
    });
  }
  return errors;
}
```

- [ ] **Step 4: Rewrite `release.ts`, delete `archive.ts`**

`packages/shared/src/release.ts`:

```ts
/**
 * Release packaging + reference reassembly for protocol v2. {@link buildReleaseV2} is what the
 * CLI runs before signing; {@link verifyReleaseV2} is the reference implementation of the device
 * pipeline (verify signature → per-blob hash → decrypt with AAD → decompress → per-file hash) that
 * the Kotlin/Swift ports must mirror and that `dash-ota verify-release` uses in CI.
 *
 * @module release
 */

import {
  compressForBlob,
  DEFAULT_ASSET_ZSTD_LEVEL,
  DEFAULT_BUNDLE_ZSTD_LEVEL,
  zstdDecompress,
} from './compression.js';
import { aesGcmDecrypt, aesGcmEncrypt, type KeyObject, randomAesKey, sha256Hex } from './crypto.js';
import {
  type Channel,
  type EncryptionV2,
  type FileEntryV2,
  type ManifestV2,
  type Platform,
  type SignedManifest,
  validateManifestShape,
  verifyManifest,
} from './manifest.js';
import { validatePath } from './paths.js';

/** One file of a payload: its manifest path and plaintext bytes. */
export interface ArchiveFile {
  path: string;
  data: Buffer;
}

/** Inputs to build (but not yet sign) a v2 release. */
export interface BuildReleaseV2Input {
  bundleId: string;
  runtimeVersion: string;
  bundleVersion: number;
  platform: Platform;
  channel: Channel;
  appId: string;
  mandatory: boolean;
  files: ArchiveFile[];
  /** the manifest path of the bytecode / JS entry file (gets `role: "bundle"`). */
  bundlePath: string;
  keyId: string;
  /** AES-256-GCM per blob with a fresh release key (default `true`); `false` stores compressed plaintext. */
  encrypt?: boolean;
  bundleCompressionLevel?: number;
  assetCompressionLevel?: number;
  targetAppVersions?: string;
  minNativeBuild?: number;
  releaseNotes?: string;
}

/** A built (unsigned) release: the manifest and the stored bytes of every blob, keyed by `blob.sha256`. */
export interface BuiltReleaseV2 {
  manifest: ManifestV2;
  blobs: Map<string, Buffer>;
  /** the release content key (also in the manifest), or null when `encrypt: false`. */
  contentKey: Buffer | null;
}

/** AAD binding a blob to its release and plaintext identity: `${bundleId}/${fileSha256}`. */
export function blobAad(bundleId: string, fileSha256: string): Buffer {
  return Buffer.from(`${bundleId}/${fileSha256}`, 'utf8');
}

/** Unique blob hashes referenced by a manifest (files + patches). */
export function collectBlobShas(manifest: ManifestV2): string[] {
  const out = new Set<string>();
  for (const f of manifest.files) out.add(f.blob.sha256);
  for (const p of manifest.patches) out.add(p.blob.sha256);
  return [...out];
}

/** Sum of stored sizes over the unique blobs of a manifest. */
export function totalBlobBytes(manifest: ManifestV2): number {
  const seen = new Set<string>();
  let total = 0;
  for (const b of [...manifest.files.map((f) => f.blob), ...manifest.patches.map((p) => p.blob)]) {
    if (seen.has(b.sha256)) continue;
    seen.add(b.sha256);
    total += b.size;
  }
  return total;
}

/**
 * Compress + (optionally) encrypt every file into its own blob and build the unsigned manifest.
 * Sign the returned `manifest` with the CLI's private key to get a {@link SignedManifest}.
 * @throws {Error} on an invalid path or when `bundlePath` is not among `files`
 */
export async function buildReleaseV2(input: BuildReleaseV2Input): Promise<BuiltReleaseV2> {
  const encrypt = input.encrypt ?? true;
  const contentKey = encrypt ? randomAesKey() : null;
  const sorted = [...input.files].sort((a, b) => a.path.localeCompare(b.path));
  if (!sorted.some((f) => f.path === input.bundlePath)) {
    throw new Error(`buildReleaseV2: bundlePath ${input.bundlePath} is not among the files`);
  }
  const blobs = new Map<string, Buffer>();
  const files: FileEntryV2[] = [];
  for (const f of sorted) {
    const pathError = validatePath(f.path);
    if (pathError) throw new Error(`buildReleaseV2: ${f.path}: ${pathError}`);
    const isBundle = f.path === input.bundlePath;
    const level = isBundle
      ? (input.bundleCompressionLevel ?? DEFAULT_BUNDLE_ZSTD_LEVEL)
      : (input.assetCompressionLevel ?? DEFAULT_ASSET_ZSTD_LEVEL);
    const fileSha = sha256Hex(f.data);
    const packed = await compressForBlob(f.path, f.data, level);
    let stored = packed.data;
    let ivB64: string | undefined;
    let tagB64: string | undefined;
    if (contentKey) {
      const enc = aesGcmEncrypt(contentKey, packed.data, blobAad(input.bundleId, fileSha));
      stored = enc.ciphertext;
      ivB64 = enc.ivB64;
      tagB64 = enc.tagB64;
    }
    const blobSha = sha256Hex(stored);
    blobs.set(blobSha, stored);
    files.push({
      path: f.path,
      ...(isBundle ? { role: 'bundle' as const } : {}),
      sha256: fileSha,
      size: f.data.length,
      blob: {
        sha256: blobSha,
        size: stored.length,
        compression: packed.compression,
        ...(ivB64 !== undefined && tagB64 !== undefined ? { ivB64, tagB64 } : {}),
      },
    });
  }
  const encryption: EncryptionV2 = contentKey
    ? { mode: 'aes-256-gcm', contentKeyB64: contentKey.toString('base64') }
    : { mode: 'none' };
  const manifest: ManifestV2 = {
    schema: 2,
    protocol: 2,
    bundleId: input.bundleId,
    runtimeVersion: input.runtimeVersion,
    bundleVersion: input.bundleVersion,
    platform: input.platform,
    channel: input.channel,
    appId: input.appId,
    createdAt: new Date().toISOString(),
    mandatory: input.mandatory,
    ...(input.minNativeBuild !== undefined ? { minNativeBuild: input.minNativeBuild } : {}),
    ...(input.targetAppVersions ? { targetAppVersions: input.targetAppVersions } : {}),
    encryption,
    files,
    patches: [],
    ...(input.releaseNotes ? { releaseNotes: input.releaseNotes } : {}),
    keyId: input.keyId,
  };
  const errors = validateManifestShape(manifest);
  if (errors.length > 0) throw new Error(`buildReleaseV2: produced an invalid manifest: ${errors.join('; ')}`);
  return { manifest, blobs, contentKey };
}

/** Fetches the stored bytes of one blob by `blob.sha256`. */
export type BlobFetcher = (blobSha256: string) => Promise<Buffer>;

/** The verified plaintext files of a release, in manifest (sorted-path) order. */
export interface VerifiedReleaseV2 {
  files: ArchiveFile[];
}

/**
 * Reassemble a release exactly as the native client must: verify the Ed25519 signature against a
 * **trusted** key, validate the shape, then for every file fetch its blob, check the stored-bytes
 * size + hash, decrypt with the release key and the `${bundleId}/${sha256}` AAD, decompress, and
 * check the plaintext size + hash. Patches are ignored here (M3). Throws (fails closed) on any
 * discrepancy.
 * @param signed the signed manifest from `/check`
 * @param fetchBlob returns the stored bytes for a `blob.sha256`
 * @param trustedPublicKey a key from the app's embedded key ring (PEM or KeyObject)
 * @throws {Error} on signature/shape/hash/decrypt failure
 */
export async function verifyReleaseV2(
  signed: SignedManifest,
  fetchBlob: BlobFetcher,
  trustedPublicKey: string | KeyObject,
): Promise<VerifiedReleaseV2> {
  if (!verifyManifest(signed, trustedPublicKey)) throw new Error('verifyReleaseV2: manifest signature invalid');
  const m = signed.manifest;
  const errors = validateManifestShape(m);
  if (errors.length > 0) throw new Error(`verifyReleaseV2: invalid manifest: ${errors.join('; ')}`);
  const key = m.encryption.mode === 'aes-256-gcm' ? Buffer.from(m.encryption.contentKeyB64, 'base64') : null;
  const fetched = new Map<string, Buffer>();
  const files: ArchiveFile[] = [];
  for (const entry of m.files) {
    let stored = fetched.get(entry.blob.sha256);
    if (!stored) {
      stored = await fetchBlob(entry.blob.sha256);
      fetched.set(entry.blob.sha256, stored);
    }
    if (stored.length !== entry.blob.size) throw new Error(`verifyReleaseV2: blob size mismatch for ${entry.path}`);
    if (sha256Hex(stored) !== entry.blob.sha256) throw new Error(`verifyReleaseV2: blob hash mismatch for ${entry.path}`);
    let plain = stored;
    if (key) {
      if (!entry.blob.ivB64 || !entry.blob.tagB64) throw new Error(`verifyReleaseV2: missing iv/tag for ${entry.path}`);
      plain = aesGcmDecrypt(key, entry.blob.ivB64, stored, entry.blob.tagB64, blobAad(m.bundleId, entry.sha256));
    }
    if (entry.blob.compression === 'zstd') plain = await zstdDecompress(plain);
    if (plain.length !== entry.size) throw new Error(`verifyReleaseV2: size mismatch ${entry.path}`);
    if (sha256Hex(plain) !== entry.sha256) throw new Error(`verifyReleaseV2: hash mismatch ${entry.path}`);
    files.push({ path: entry.path, data: plain });
  }
  return { files };
}
```

Delete the archive module:

```bash
git rm packages/shared/src/archive.ts
```

- [ ] **Step 5: `protocol.ts` and `index.ts`**

In `protocol.ts` add after `CheckRequest` (and change the `/ota/v1/` mentions in the JSDoc of `EnrollRequest`, `CheckRequest`, `CheckResponse`, `ConfirmRequest` to `/ota/v2/`):

```ts
/**
 * POST /ota/v2/check — the v2 update query. `currentBundleId` is `""` and `currentBundleSha256`
 * is the hash of the embedded bytecode when no OTA bundle is applied; both let the device pick a
 * bytecode patch (M3). The backend records but does not act on them in M2.
 */
export interface CheckRequestV2 extends CheckRequest {
  protocol: 2;
  currentBundleId: string;
  currentBundleSha256: string;
}
```

In `index.ts` remove `export * from './archive.js';` — the final file:

```ts
export * from './canonical.js';
export * from './crypto.js';
export * from './paths.js';
export * from './compression.js';
export * from './manifest.js';
export * from './targeting.js';
export * from './fingerprint.js';
export * from './protocol.js';
export * from './request.js';
export * from './release.js';
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npm run test:core && npx tsc -p packages/shared && npx eslint packages/shared && npx prettier --check "packages/shared/src/**/*.ts"`
Expected: `22 checks passed.`; shared typecheck, lint and format clean. (`tsc -p packages/backend` is now red — expected until Task 11; `npm run test:e2e` / `test:express` red until Tasks 9 / 11.)

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/manifest.ts packages/shared/src/release.ts packages/shared/src/protocol.ts packages/shared/src/index.ts packages/shared/src/selftest.ts
git commit -m "feat(shared)!: manifest schema 2 with per-file blobs, buildReleaseV2/verifyReleaseV2; drop SOA1"
```

---

### Task 5: HTTP router — `PUT`, `:param` routes, streaming bodies, Range parsing

**Files:**
- Rewrite: `packages/backend/src/http.ts`
- Create: `packages/backend/src/http.test.ts`
- Modify: `package.json` (root — `test:http` script)
- Modify: `packages/backend/src/index.ts` (exports)

**Interfaces:**
- Produces (from `./http.js`):
  - `type HttpMethod = 'GET' | 'POST' | 'PUT'`
  - `interface OtaRoute { method: HttpMethod; path: string; handler: Handler; stream?: boolean }` — `path` may contain `:name` segments; `stream: true` means the body is **not** buffered and arrives as `ctx.bodyStream`.
  - `interface ReqCtx { method; path; query; headers; rawBody: Buffer; params: Record<string, string>; bodyStream?: Readable; json<T>(): T }`
  - `interface CompiledRoute { route: OtaRoute; matcher: RegExp; keys: string[] }`, `interface RouteMatch { route: OtaRoute; params: Record<string, string> }`
  - `compileRoute(route): CompiledRoute`, `compileRoutes(routes): CompiledRoute[]`, `matchRoute(compiled, method, pathname): RouteMatch | null`
  - `makeCtx(match, method, parsed: URL, headers, rawBody, bodyStream?): ReqCtx`
  - `interface ByteRange { start: number; end: number }`, `parseRangeHeader(value: string | undefined, size: number): ByteRange | 'invalid' | null` — supports `bytes=a-b` and `bytes=a-` only; `null` when absent.
  - `binaryStream(body, contentLength, contentType = 'application/octet-stream', status = 200, headers?: Record<string, string>)`
  - `Router.on(method: HttpMethod, path, handler, stream = false)`, `Router.register(routes)`, `Router.dispatch(method, url, headers, rawBody, bodyStream?)`, `Router.listen(port)`.
- Consumed by Tasks 9–11 (routes with params/streaming/ranges) and the Express adapter.

- [ ] **Step 1: Write the failing test**

`packages/backend/src/http.test.ts`:

```ts
/**
 * Unit checks for the dependency-free router: `:param` matching, Range parsing, and a streaming
 * route that never buffers its body. Run: `npm run test:http`.
 *
 * @module http.test
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { compileRoutes, json, matchRoute, parseRangeHeader, Router } from './http.js';

let passed = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

async function main(): Promise<void> {
  console.log('dash-ota http router\n');

  await check('route params are captured and decoded; method + shape must match', () => {
    const compiled = compileRoutes([
      { method: 'GET', path: '/ota/v2/releases/:bundleId/blobs/:sha', handler: () => json({}) },
      { method: 'POST', path: '/admin/releases', handler: () => json({}) },
    ]);
    const hit = matchRoute(compiled, 'get', '/ota/v2/releases/bnd%5F1/blobs/abc');
    assert.deepEqual(hit?.params, { bundleId: 'bnd_1', sha: 'abc' });
    assert.equal(matchRoute(compiled, 'GET', '/ota/v2/releases/bnd_1/blobs'), null);
    assert.equal(matchRoute(compiled, 'GET', '/ota/v2/releases/bnd_1/blobs/abc/extra'), null);
    assert.equal(matchRoute(compiled, 'GET', '/admin/releases'), null);
    assert.deepEqual(matchRoute(compiled, 'POST', '/admin/releases')?.params, {});
  });

  await check('parseRangeHeader implements bytes=a-b and bytes=a- with 416 semantics', () => {
    assert.equal(parseRangeHeader(undefined, 10), null);
    assert.equal(parseRangeHeader('', 10), null);
    assert.deepEqual(parseRangeHeader('bytes=0-3', 10), { start: 0, end: 3 });
    assert.deepEqual(parseRangeHeader('bytes=4-', 10), { start: 4, end: 9 });
    assert.deepEqual(parseRangeHeader('bytes=4-100', 10), { start: 4, end: 9 });
    assert.equal(parseRangeHeader('bytes=10-', 10), 'invalid');
    assert.equal(parseRangeHeader('bytes=5-2', 10), 'invalid');
    assert.equal(parseRangeHeader('bytes=-5', 10), 'invalid');
    assert.equal(parseRangeHeader('items=0-1', 10), 'invalid');
  });

  await check('a stream:true route receives the live body and an empty rawBody', async () => {
    const router = new Router().register([
      {
        method: 'PUT',
        path: '/up/:id',
        stream: true,
        handler: async (ctx) => {
          const hash = createHash('sha256');
          let n = 0;
          for await (const chunk of ctx.bodyStream!) {
            const buf = chunk as Buffer;
            hash.update(buf);
            n += buf.length;
          }
          return json({ id: ctx.params.id, n, sha: hash.digest('hex'), buffered: ctx.rawBody.length });
        },
      },
    ]);
    const server = await router.listen(0);
    const port = (server.address() as { port: number }).port;
    const body = Buffer.alloc(300_000, 7);
    const res = await fetch(`http://localhost:${port}/up/x1`, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body,
    });
    const data = (await res.json()) as { id: string; n: number; sha: string; buffered: number };
    assert.equal(res.status, 200);
    assert.equal(data.id, 'x1');
    assert.equal(data.n, body.length);
    assert.equal(data.buffered, 0);
    assert.equal(data.sha, createHash('sha256').update(body).digest('hex'));
    const miss = await fetch(`http://localhost:${port}/nope`);
    assert.equal(miss.status, 404);
    server.close();
  });

  console.log(`\n${passed} http checks passed.`);
}

void main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
```

Root `package.json`: add `"test:http": "tsx --conditions source packages/backend/src/http.test.ts",` and insert `npm run test:http && ` right after `npm run test:cli && ` in the `test` chain.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test:http`
Expected: FAIL — `does not provide an export named 'compileRoutes'`.

- [ ] **Step 3: Rewrite `http.ts`**

```ts
/**
 * A tiny dependency-free HTTP router over `node:http`. Deliberately minimal — keeping the
 * backend's dependency (and supply-chain) surface near zero is on-theme for a security project.
 * Routes are `METHOD /exact/or/:param/paths`; a route declared `stream: true` receives its body
 * as a live stream (large blob uploads) instead of a buffered `rawBody`.
 *
 * @module http
 */

import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { pipeline, type Readable } from 'node:stream';
import { URL } from 'node:url';

export type HttpMethod = 'GET' | 'POST' | 'PUT';

/** Per-request context passed to handlers. */
export interface ReqCtx {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingHttpHeaders;
  /** buffered request body — always empty for routes declared `stream: true`. */
  rawBody: Buffer;
  /** `:name` path segments captured from the route. */
  params: Record<string, string>;
  /** the live request body — present only for routes declared `stream: true`. */
  bodyStream?: Readable;
  /** parse the raw body as JSON (throws on invalid JSON). */
  json<T>(): T;
}

/** A JSON response. */
export interface JsonResult {
  kind?: 'json';
  status?: number;
  body: unknown;
  headers?: Record<string, string>;
}

/**
 * A binary response. The body may be a `Buffer` or a `Readable`; set {@link contentLength} so the
 * client receives `Content-Length` (drives download progress and Range bookkeeping).
 */
export interface BinaryResult {
  kind: 'binary';
  status?: number;
  contentType: string;
  body: Buffer | Readable;
  contentLength?: number;
  headers?: Record<string, string>;
}

export type HandlerResult = JsonResult | BinaryResult;
export type Handler = (ctx: ReqCtx) => Promise<HandlerResult> | HandlerResult;

/** A framework-agnostic route: method + path pattern + handler. Consumed by every adapter. */
export interface OtaRoute {
  method: HttpMethod;
  /** exact path, or a pattern with `:name` segments (one segment each), e.g. `/admin/releases/:bundleId/finalize`. */
  path: string;
  handler: Handler;
  /** do not buffer the body; hand it to the handler as `ctx.bodyStream`. */
  stream?: boolean;
}

/** A route compiled to a matcher. */
export interface CompiledRoute {
  route: OtaRoute;
  matcher: RegExp;
  keys: string[];
}

/** A matched route plus its captured params. */
export interface RouteMatch {
  route: OtaRoute;
  params: Record<string, string>;
}

/** Compile a route path into a regexp; `:name` segments capture one path segment each. */
export function compileRoute(route: OtaRoute): CompiledRoute {
  const keys: string[] = [];
  const source = route.path
    .split('/')
    .map((seg) => {
      if (seg.startsWith(':')) {
        keys.push(seg.slice(1));
        return '([^/]+)';
      }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return { route, matcher: new RegExp(`^${source}$`), keys };
}

/** Compile a route table. */
export function compileRoutes(routes: readonly OtaRoute[]): CompiledRoute[] {
  return routes.map(compileRoute);
}

/** Find the first route matching `method` + `pathname`; params are URL-decoded. */
export function matchRoute(compiled: readonly CompiledRoute[], method: string, pathname: string): RouteMatch | null {
  const m = method.toUpperCase();
  for (const c of compiled) {
    if (c.route.method !== m) continue;
    const hit = c.matcher.exec(pathname);
    if (!hit) continue;
    const params: Record<string, string> = {};
    c.keys.forEach((k, i) => {
      params[k] = decodeURIComponent(hit[i + 1] ?? '');
    });
    return { route: c.route, params };
  }
  return null;
}

/** Build the handler context for a matched route. */
export function makeCtx(
  match: RouteMatch,
  method: string,
  parsed: URL,
  headers: IncomingHttpHeaders,
  rawBody: Buffer,
  bodyStream?: Readable,
): ReqCtx {
  return {
    method: method.toUpperCase(),
    path: parsed.pathname,
    query: parsed.searchParams,
    headers,
    rawBody,
    params: match.params,
    ...(bodyStream ? { bodyStream } : {}),
    json<T>(): T {
      return JSON.parse(rawBody.toString('utf8') || 'null') as T;
    },
  };
}

/** An inclusive byte range within a body of known size. */
export interface ByteRange {
  start: number;
  end: number;
}

/**
 * Parse a `Range` header against a known size. Supports `bytes=a-b` and `bytes=a-` (the forms the
 * dash-ota client sends). Returns `null` when absent, `'invalid'` when unsatisfiable (→ 416).
 */
export function parseRangeHeader(value: string | undefined, size: number): ByteRange | 'invalid' | null {
  if (value === undefined || value === '') return null;
  const m = /^bytes=(\d+)-(\d*)$/.exec(value.trim());
  if (!m) return 'invalid';
  const start = Number(m[1] ?? '');
  if (!Number.isSafeInteger(start) || start >= size) return 'invalid';
  const end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  if (!Number.isSafeInteger(end) || end < start) return 'invalid';
  return { start, end };
}

/** Build a JSON response. */
export function json(body: unknown, status = 200, headers?: Record<string, string>): JsonResult {
  return { kind: 'json', status, body, headers };
}

/** Build a buffered binary response. Prefer {@link binaryStream} for large payloads. */
export function binary(body: Buffer, contentType = 'application/octet-stream', status = 200): BinaryResult {
  return { kind: 'binary', status, contentType, body, contentLength: body.byteLength };
}

/** Build a streaming binary response with a known content length (never buffered whole). */
export function binaryStream(
  body: Readable,
  contentLength: number,
  contentType = 'application/octet-stream',
  status = 200,
  headers?: Record<string, string>,
): BinaryResult {
  return { kind: 'binary', status, contentType, body, contentLength, headers };
}

/** Build a JSON error response. */
export function httpError(status: number, error: string, code?: string): JsonResult {
  return { kind: 'json', status, body: { error, code } };
}

/** Write a {@link HandlerResult} to a `node:http` (or Express) `ServerResponse`. */
export function writeNodeResult(res: import('node:http').ServerResponse, result: HandlerResult): void {
  const status = result.status ?? 200;
  if (result.kind === 'binary') {
    const headers: Record<string, string> = { 'content-type': result.contentType, ...(result.headers ?? {}) };
    if (result.contentLength !== undefined) headers['content-length'] = String(result.contentLength);
    res.writeHead(status, headers);
    if (Buffer.isBuffer(result.body)) {
      res.end(result.body);
    } else {
      // `pipeline` destroys BOTH ends on any error or a client abort — so the file descriptor is
      // always released. The status/headers are already sent, so on a mid-transfer error we can
      // only tear the socket down.
      pipeline(result.body, res, () => {});
    }
    return;
  }
  res.writeHead(status, { 'content-type': 'application/json', ...(result.headers ?? {}) });
  res.end(JSON.stringify(result.body));
}

/** A minimal pattern router. */
export class Router {
  private readonly compiled: CompiledRoute[] = [];

  /** Register a handler for `METHOD path` (`path` may contain `:param` segments). */
  on(method: HttpMethod, path: string, handler: Handler, stream = false): this {
    this.compiled.push(compileRoute({ method, path, handler, stream }));
    return this;
  }

  get(path: string, handler: Handler): this {
    return this.on('GET', path, handler);
  }

  post(path: string, handler: Handler): this {
    return this.on('POST', path, handler);
  }

  /** Register a batch of framework-agnostic routes. */
  register(routes: readonly OtaRoute[]): this {
    for (const r of routes) this.compiled.push(compileRoute(r));
    return this;
  }

  /** Start an HTTP server bound to `port`. Resolves once listening. */
  listen(port: number): Promise<Server> {
    const server = createServer((req, res) => {
      const method = (req.method ?? 'GET').toUpperCase();
      const parsed = new URL(req.url ?? '/', 'http://localhost');
      const match = matchRoute(this.compiled, method, parsed.pathname);
      const finish = (rawBody: Buffer, bodyStream?: Readable): void => {
        void this.run(match, method, parsed, req.headers, rawBody, bodyStream)
          .then((result) => this.write(res, result))
          .catch((err: unknown) => {
            const message = err instanceof Error ? err.message : 'internal error';
            this.write(res, httpError(500, message, 'internal'));
          });
      };
      if (match?.route.stream) {
        // Streaming route: hand the request over untouched — the handler consumes it.
        finish(Buffer.alloc(0), req);
        return;
      }
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => finish(Buffer.concat(chunks)));
      req.on('error', () => this.write(res, httpError(400, 'bad request')));
    });
    return new Promise((resolve) => server.listen(port, () => resolve(server)));
  }

  /** Resolve a route and run it (also reachable directly from tests). */
  async dispatch(
    method: string,
    url: string,
    headers: IncomingHttpHeaders,
    rawBody: Buffer,
    bodyStream?: Readable,
  ): Promise<HandlerResult> {
    const parsed = new URL(url, 'http://localhost');
    return this.run(matchRoute(this.compiled, method, parsed.pathname), method, parsed, headers, rawBody, bodyStream);
  }

  private async run(
    match: RouteMatch | null,
    method: string,
    parsed: URL,
    headers: IncomingHttpHeaders,
    rawBody: Buffer,
    bodyStream?: Readable,
  ): Promise<HandlerResult> {
    if (!match) return httpError(404, `no route for ${method} ${parsed.pathname}`, 'not_found');
    return match.route.handler(makeCtx(match, method, parsed, headers, rawBody, bodyStream));
  }

  private write(res: import('node:http').ServerResponse, result: HandlerResult): void {
    writeNodeResult(res, result);
  }
}
```

In `packages/backend/src/index.ts` extend the two `./http.js` export lines to:

```ts
export { Router, json, binary, binaryStream, httpError, writeNodeResult, compileRoute, compileRoutes, matchRoute, makeCtx, parseRangeHeader } from './http.js';
export type { OtaRoute, ReqCtx, HandlerResult, JsonResult, BinaryResult, Handler, HttpMethod, CompiledRoute, RouteMatch, ByteRange } from './http.js';
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test:http`
Expected: `3 http checks passed.` (Note: `express.ts` still compiles against `OtaRoute.method` — the union widened, nothing else changed for it.)

- [ ] **Step 5: Commit**

```bash
git add package.json packages/backend/src/http.ts packages/backend/src/http.test.ts packages/backend/src/index.ts
git commit -m "feat(backend): router supports PUT, :param routes, streaming bodies and Range parsing"
```

---

### Task 6: Providers — `BlobStore` v2, reusable tokens, retired-client counters, `ReleaseRecord` v2

**Files:**
- Modify: `packages/backend/src/providers.ts`
- Create: `packages/backend/src/providers.test.ts`
- Modify: `package.json` (root — `test:providers`)
- Modify: `packages/backend/src/index.ts`, `packages/backend/src/store.ts` (re-exports only)

**Interfaces:**
- Consumes: `ByteRange` (Task 5).
- Produces (from `./providers.js`):
  - `interface BlobStore { put(key: string, data: Buffer | Readable, size?: number): Promise<void>; get(key): Promise<Buffer | null>; stat(key): Promise<{ size: number } | null>; openReadStream(key, range?: ByteRange): Promise<Readable | null>; delete(key): Promise<void>; deletePrefix(prefix: string): Promise<void> }` — keys are `/`-separated; `size` is required by adapters that need a content length for stream bodies (S3); `deletePrefix` expects a directory-shaped prefix ending in `/`.
  - `releaseBlobKey(bundleId, blobSha256): string` → `releases/${bundleId}/${blobSha256}`; `releaseBlobPrefix(bundleId): string` → `releases/${bundleId}/`
  - `CacheProvider.getToken(token: string): Promise<string | null>` — non-consuming read (null when absent or expired).
  - `type RetiredClientCounts = Record<string, Record<string, number>>`; `DatabaseProvider.incrementRetiredClient(channel, platform): Promise<void>`; `DatabaseProvider.getRetiredClients(): Promise<RetiredClientCounts>`
  - `ReleaseRecord` gains `schema: 2; bundleSha256: string; blobCount: number; totalBytes: number; finalized: boolean`.
- Consumed by Tasks 7–10.

- [ ] **Step 1: Write the failing test**

`packages/backend/src/providers.test.ts`:

```ts
/**
 * Checks for the zero-dependency default providers: nested blob keys with Range reads and prefix
 * deletes, non-consuming token reads with expiry, and durable retired-client counters.
 * Run: `npm run test:providers`.
 *
 * @module providers.test
 */

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { DiskBlobStore, DiskDatabaseProvider, MemoryCacheProvider, releaseBlobKey, releaseBlobPrefix } from './providers.js';

let passed = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c as Uint8Array));
  return Buffer.concat(chunks);
}

async function main(): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), 'dash-ota-providers-'));
  console.log('dash-ota default providers\n');

  const blob = new DiskBlobStore(join(tmp, 'storage'));
  const sha = 'a'.repeat(64);
  const other = 'b'.repeat(64);

  await check('blob keys are per-release paths', () => {
    assert.equal(releaseBlobKey('bnd_1', sha), `releases/bnd_1/${sha}`);
    assert.equal(releaseBlobPrefix('bnd_1'), 'releases/bnd_1/');
    return Promise.resolve();
  });

  await check('put (Buffer + stream) / stat / get / range read on nested keys', async () => {
    await blob.put(releaseBlobKey('bnd_1', sha), Buffer.from('0123456789'));
    await blob.put(releaseBlobKey('bnd_1', other), Readable.from([Buffer.from('ab'), Buffer.from('cd')]), 4);
    assert.deepEqual(await blob.stat(releaseBlobKey('bnd_1', sha)), { size: 10 });
    assert.deepEqual(await blob.stat(releaseBlobKey('bnd_1', other)), { size: 4 });
    assert.equal((await blob.get(releaseBlobKey('bnd_1', other)))?.toString(), 'abcd');
    const whole = await blob.openReadStream(releaseBlobKey('bnd_1', sha));
    assert.equal((await collect(whole!)).toString(), '0123456789');
    const part = await blob.openReadStream(releaseBlobKey('bnd_1', sha), { start: 2, end: 5 });
    assert.equal((await collect(part!)).toString(), '2345');
    assert.equal(await blob.openReadStream(releaseBlobKey('bnd_1', 'c'.repeat(64))), null);
  });

  await check('delete and deletePrefix remove only what they name', async () => {
    await blob.put(releaseBlobKey('bnd_2', sha), Buffer.from('x'));
    await blob.delete(releaseBlobKey('bnd_1', other));
    assert.equal(await blob.stat(releaseBlobKey('bnd_1', other)), null);
    assert.deepEqual(await blob.stat(releaseBlobKey('bnd_1', sha)), { size: 10 });
    await blob.deletePrefix(releaseBlobPrefix('bnd_1'));
    assert.equal(await blob.stat(releaseBlobKey('bnd_1', sha)), null);
    assert.deepEqual(await blob.stat(releaseBlobKey('bnd_2', sha)), { size: 1 });
    await blob.deletePrefix(releaseBlobPrefix('bnd_missing')); // no-op
  });

  await check('traversal-shaped keys are rejected', async () => {
    await assert.rejects(blob.put('../escape', Buffer.from('x')), /invalid key/);
    await assert.rejects(blob.stat('releases//x'), /invalid key/);
    await assert.rejects(blob.get('/abs'), /invalid key/);
  });

  const cache = new MemoryCacheProvider();

  await check('getToken reads without consuming; consumeToken still single-use; expiry honoured', async () => {
    await cache.putToken('t1', 'v1', 5_000);
    assert.equal(await cache.getToken('t1'), 'v1');
    assert.equal(await cache.getToken('t1'), 'v1');
    assert.equal(await cache.consumeToken('t1'), 'v1');
    assert.equal(await cache.getToken('t1'), null);
    await cache.putToken('t2', 'v2', 1);
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(await cache.getToken('t2'), null);
    assert.equal(await cache.getToken('never'), null);
  });

  await check('retired-client counters increment and survive a reload', async () => {
    const dataDir = join(tmp, 'data');
    const db = new DiskDatabaseProvider(dataDir);
    assert.deepEqual(await db.getRetiredClients(), {});
    await db.incrementRetiredClient('prod', 'android');
    await db.incrementRetiredClient('prod', 'android');
    await db.incrementRetiredClient('prod', 'ios');
    assert.deepEqual(await db.getRetiredClients(), { prod: { android: 2, ios: 1 } });
    const reloaded = new DiskDatabaseProvider(dataDir);
    assert.deepEqual(await reloaded.getRetiredClients(), { prod: { android: 2, ios: 1 } });
  });

  console.log(`\n${passed} provider checks passed.`);
}

void main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
```

Root `package.json`: add `"test:providers": "tsx --conditions source packages/backend/src/providers.test.ts",` and `npm run test:providers && ` after `test:http` in the `test` chain.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test:providers`
Expected: FAIL — `does not provide an export named 'releaseBlobKey'`.

- [ ] **Step 3: Implement**

In `providers.ts`:

(a) Replace the import block with:

```ts
import { randomBytes } from 'node:crypto';
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { NativeVersionPolicy, SignedManifest } from '@dash-ota/shared';
import type { ByteRange } from './http.js';
```

(b) Replace the `ReleaseRecord` interface with:

```ts
/** A published release the backend serves (its blobs live in the {@link BlobStore} under `releases/<bundleId>/`). */
export interface ReleaseRecord {
  bundleId: string;
  platform: string;
  channel: string;
  runtimeVersion: string;
  bundleVersion: number;
  signedManifest: SignedManifest;
  rolloutPercentage: number;
  paused: boolean;
  rolledBack: boolean;
  createdAt: string;
  adoption: AdoptionStats;
  /** manifest schema this record was ingested under. */
  schema: 2;
  /** plaintext SHA-256 of the `role: "bundle"` file (the bytecode) — the base id for M3 patches. */
  bundleSha256: string;
  /** unique blobs declared by the manifest. */
  blobCount: number;
  /** sum of the declared blob sizes. */
  totalBytes: number;
  /** all blobs present and verified; only finalized releases are ever offered. */
  finalized: boolean;
}
```

(c) Add after `InstallRecord`:

```ts
/** Hits on the retired v1 tombstone routes, `channel → platform → count`. */
export type RetiredClientCounts = Record<string, Record<string, number>>;
```

(d) In `DatabaseProvider` add:

```ts
  /** Atomically count a hit on a retired-protocol route. */
  incrementRetiredClient(channel: string, platform: string): Promise<void>;
  getRetiredClients(): Promise<RetiredClientCounts>;
```

(e) Replace the `BlobStore` interface with:

```ts
/**
 * The blob byte store. Keys are `/`-separated paths; releases use `releases/<bundleId>/<blobSha256>`
 * (see {@link releaseBlobKey}) so one release can be removed with {@link BlobStore.deletePrefix}.
 */
export interface BlobStore {
  /** Store bytes. A `Readable` body needs `size` for adapters that must send a content length (S3). */
  put(key: string, data: Buffer | Readable, size?: number): Promise<void>;
  /** The whole blob, or `null` if absent. Prefer {@link openReadStream} to serve downloads. */
  get(key: string): Promise<Buffer | null>;
  /** Byte length of the stored blob, or `null` if absent. */
  stat(key: string): Promise<{ size: number } | null>;
  /** Streaming reader over the blob (optionally an inclusive byte range), or `null` if absent. */
  openReadStream(key: string, range?: ByteRange): Promise<Readable | null>;
  /** Remove one blob (no-op if absent). */
  delete(key: string): Promise<void>;
  /** Remove every blob under a directory-shaped prefix such as `releases/<bundleId>/`. */
  deletePrefix(prefix: string): Promise<void>;
}

/** Blob key for one stored blob of a release. */
export function releaseBlobKey(bundleId: string, blobSha256: string): string {
  return `releases/${bundleId}/${blobSha256}`;
}

/** Prefix under which all blobs of a release live. */
export function releaseBlobPrefix(bundleId: string): string {
  return `releases/${bundleId}/`;
}
```

(f) In `CacheProvider` add after `consumeToken`:

```ts
  /** Read a token's value **without** consuming it (`null` when absent or expired). */
  getToken(token: string): Promise<string | null>;
```

(g) In `DiskDatabaseProvider`: add the field `private readonly retired = new Map<string, number>();` and `private readonly retiredFile: string;`, set `this.retiredFile = join(dataDir, 'retired-clients.json');` in the constructor before `this.load()`, add to `load()`:

```ts
    if (existsSync(this.retiredFile))
      for (const [k, v] of Object.entries(JSON.parse(readFileSync(this.retiredFile, 'utf8')) as Record<string, number>))
        this.retired.set(k, v);
```

and add the two methods:

```ts
  async incrementRetiredClient(channel: string, platform: string): Promise<void> {
    const key = `${channel}\n${platform}`;
    this.retired.set(key, (this.retired.get(key) ?? 0) + 1);
    this.write(this.retiredFile, Object.fromEntries(this.retired));
  }
  async getRetiredClients(): Promise<RetiredClientCounts> {
    const out: RetiredClientCounts = {};
    for (const [key, count] of this.retired) {
      const [channel = 'unknown', platform = 'unknown'] = key.split('\n');
      (out[channel] ??= {})[platform] = count;
    }
    return out;
  }
```

(h) Replace `DiskBlobStore` with:

```ts
/** Default blob store: one file per key under `storageDir` (keys map to nested directories). */
export class DiskBlobStore implements BlobStore {
  private readonly root: string;

  constructor(dir: string) {
    this.root = resolve(dir);
    mkdirSync(this.root, { recursive: true });
  }

  /** Resolve a key to a path inside the root; refuses anything traversal-shaped. */
  private path(key: string): string {
    const segments = key.split('/');
    if (key.length === 0 || key.includes('\0') || segments.some((s) => s === '' || s === '.' || s === '..')) {
      throw new Error(`DiskBlobStore: invalid key ${JSON.stringify(key)}`);
    }
    return join(this.root, ...segments);
  }

  async put(key: string, data: Buffer | Readable, _size?: number): Promise<void> {
    const dest = this.path(key);
    mkdirSync(dirname(dest), { recursive: true });
    const tmp = `${dest}.${randomBytes(6).toString('hex')}.tmp`;
    if (Buffer.isBuffer(data)) writeFileSync(tmp, data);
    else await pipeline(data, createWriteStream(tmp));
    renameSync(tmp, dest);
  }

  async get(key: string): Promise<Buffer | null> {
    const p = this.path(key);
    return existsSync(p) ? readFileSync(p) : null;
  }

  async stat(key: string): Promise<{ size: number } | null> {
    const p = this.path(key);
    return existsSync(p) ? { size: statSync(p).size } : null;
  }

  async openReadStream(key: string, range?: ByteRange): Promise<Readable | null> {
    const p = this.path(key);
    if (!existsSync(p)) return null;
    return createReadStream(p, range ? { start: range.start, end: range.end } : undefined);
  }

  async delete(key: string): Promise<void> {
    rmSync(this.path(key), { force: true });
  }

  async deletePrefix(prefix: string): Promise<void> {
    // Directory-shaped prefixes ("releases/<bundleId>/") remove that subtree; a bare prefix
    // removes the entries of its parent directory whose names start with the last segment.
    const parts = prefix.split('/');
    const last = parts.pop() ?? '';
    const dir = parts.length > 0 ? this.path(parts.join('/')) : this.root;
    if (!existsSync(dir)) return;
    if (last === '') {
      if (dir !== this.root) rmSync(dir, { recursive: true, force: true });
      return;
    }
    for (const name of readdirSync(dir)) {
      if (name.startsWith(last)) rmSync(join(dir, name), { recursive: true, force: true });
    }
  }
}
```

(i) In `MemoryCacheProvider` add after `consumeToken`:

```ts
  async getToken(token: string): Promise<string | null> {
    const rec = this.tokens.get(token);
    if (!rec) return null;
    if (rec.expiresAt < Date.now()) {
      this.tokens.delete(token);
      return null;
    }
    return rec.value;
  }
```

(j) Re-exports: in `store.ts` extend the two `./providers.js` re-export lines so they also export `RetiredClientCounts`, `releaseBlobKey`, `releaseBlobPrefix`:

```ts
export type { AdoptionStats, ReleaseRecord, InstallRecord, RetiredClientCounts } from './providers.js';
export type { BlobStore, CacheProvider, DatabaseProvider, RateLimitResult, StoreProviders } from './providers.js';
export { DiskBlobStore, DiskDatabaseProvider, MemoryCacheProvider, releaseBlobKey, releaseBlobPrefix } from './providers.js';
```

and in `index.ts` add `releaseBlobKey, releaseBlobPrefix, type RetiredClientCounts,` inside the `from './store.js'` export list.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test:providers && npm run test:http`
Expected: `6 provider checks passed.` and http still green. (`tsc -p packages/backend` remains red until Task 7 updates the adapters that implement these interfaces — the next task.)

- [ ] **Step 5: Commit**

```bash
git add package.json packages/backend/src/providers.ts packages/backend/src/providers.test.ts packages/backend/src/store.ts packages/backend/src/index.ts
git commit -m "feat(backend)!: per-release blob keys with Range/delete, reusable tokens, retired-client counters"
```

---

### Task 7: Adapters — S3 ranges/deletes/stream puts, SQLite + Postgres counters, Redis `getToken`

**Files:**
- Modify: `packages/backend/src/adapters/s3-blob.ts`, `adapters/s3-blob.test.ts`
- Modify: `packages/backend/src/adapters/sqlite-db.ts`, `adapters/sqlite-db.test.ts`
- Modify: `packages/backend/src/adapters/postgres-db.ts`, `adapters/postgres-db.test.ts`
- Modify: `packages/backend/src/adapters/redis-cache.ts`, `adapters/redis-cache.test.ts`

**Interfaces:**
- Consumes: the interfaces from Task 6.
- Produces: `RedisLike` gains `get(key: string): Promise<string | null>`. All four adapters implement the v2 provider interfaces; S3 object keys are now `${prefix}${key}` (no `.bin` suffix).

- [ ] **Step 1: Write the failing tests**

`sqlite-db.test.ts` runs unconditionally. Update `fixtureRelease` to the v2 record (add the fields after `adoption`):

```ts
    schema: 2,
    bundleSha256: 'a'.repeat(64),
    blobCount: 1,
    totalBytes: 10,
    finalized: true,
```

and append before the final `console.log`:

```ts
  await check('retired-client counters increment atomically and aggregate', async () => {
    await db.incrementRetiredClient('prod', 'android');
    await db.incrementRetiredClient('prod', 'android');
    await db.incrementRetiredClient('prod', 'ios');
    assert.deepEqual(await db.getRetiredClients(), { prod: { android: 2, ios: 1 } });
  });
```

`postgres-db.test.ts` (skips without `OTA_TEST_DATABASE_URL`): make the same two edits — the fixture fields, and the identical check appended after the existing `'install + trusted key + native policy round-trip'` check (its helpers are also named `db` and `check`).

`redis-cache.test.ts` (skips without `OTA_TEST_REDIS_URL`): append before `await client.quit();`:

```ts
  await check('a reusable token can be read without consuming it', async () => {
    const t = `t-${process.pid}-2`;
    await cache.putToken(t, 'bundle-abc', 5000);
    assert.equal(await cache.getToken(t), 'bundle-abc');
    assert.equal(await cache.getToken(t), 'bundle-abc');
    assert.equal(await cache.consumeToken(t), 'bundle-abc');
    assert.equal(await cache.getToken(t), null);
  });
```

`s3-blob.test.ts` (skips without `OTA_TEST_S3_BUCKET`): replace the body of `main()` after the skip guard with:

```ts
  const prefix = `dash-ota-test-${process.pid}/`;
  const blob = new S3BlobStore({
    bucket,
    region: process.env.AWS_REGION,
    endpoint: process.env.OTA_TEST_S3_ENDPOINT,
    forcePathStyle: process.env.OTA_TEST_S3_FORCE_PATH_STYLE === 'true',
    prefix,
  });
  const key = `releases/bnd_s3test_${process.pid}/${'a'.repeat(64)}`;
  const streamed = `releases/bnd_s3test_${process.pid}/${'b'.repeat(64)}`;
  const payload = Buffer.from('0123456789', 'utf8');
  let passed = 0;
  const check = async (name: string, fn: () => Promise<void>): Promise<void> => {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  };
  const collect = async (stream: Readable): Promise<Buffer> => {
    const chunks: Buffer[] = [];
    for await (const c of stream) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c as Uint8Array));
    return Buffer.concat(chunks);
  };

  console.log('dash-ota s3 blob store adapter\n');

  await check('missing object → null for stat/get/stream', async () => {
    assert.equal(await blob.stat(key), null);
    assert.equal(await blob.get(key), null);
    assert.equal(await blob.openReadStream(key), null);
  });

  await check('put (Buffer + sized stream) then stat reports the exact size', async () => {
    await blob.put(key, payload);
    await blob.put(streamed, Readable.from([Buffer.from('ab'), Buffer.from('cd')]), 4);
    assert.deepEqual(await blob.stat(key), { size: payload.byteLength });
    assert.deepEqual(await blob.stat(streamed), { size: 4 });
    await assert.rejects(blob.put(`${key}x`, Readable.from([Buffer.from('z')])), /needs an explicit size/);
  });

  await check('get round-trips; whole and ranged streams yield the right bytes', async () => {
    assert.ok((await blob.get(key))?.equals(payload));
    assert.ok((await collect((await blob.openReadStream(key))!)).equals(payload));
    assert.equal((await collect((await blob.openReadStream(key, { start: 2, end: 5 }))!)).toString(), '2345');
  });

  await check('delete + deletePrefix', async () => {
    await blob.delete(streamed);
    assert.equal(await blob.stat(streamed), null);
    await blob.deletePrefix(`releases/bnd_s3test_${process.pid}/`);
    assert.equal(await blob.stat(key), null);
  });

  console.log(`\n${passed} s3 checks passed.`);
```

and change the import line to `import { Readable } from 'node:stream';` + the existing `S3BlobStore` import (the manual `DeleteObjectCommand` clean-up block is gone — `deletePrefix` is the clean-up).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test:sqlite`
Expected: FAIL — `TypeError: db.incrementRetiredClient is not a function`. (`test:redis`, `test:postgres`, `test:s3` skip without infra; if you have any of them set, they fail the same way.)

- [ ] **Step 3: Implement the adapters**

`sqlite-db.ts` — append to `SCHEMA`:

```sql
CREATE TABLE IF NOT EXISTS ota_retired_clients (
  channel  TEXT NOT NULL,
  platform TEXT NOT NULL,
  hits     INTEGER NOT NULL,
  PRIMARY KEY (channel, platform)
);
```

add the import `import type { DatabaseProvider, InstallRecord, ReleaseRecord, RetiredClientCounts } from '../providers.js';` and the methods:

```ts
  async incrementRetiredClient(channel: string, platform: string): Promise<void> {
    const db = await this.db();
    db.prepare(
      `INSERT INTO ota_retired_clients (channel, platform, hits) VALUES (?, ?, 1)
       ON CONFLICT(channel, platform) DO UPDATE SET hits = hits + 1`,
    ).run(channel, platform);
  }

  async getRetiredClients(): Promise<RetiredClientCounts> {
    const db = await this.db();
    const rows = db.prepare('SELECT channel, platform, hits FROM ota_retired_clients').all() as Array<{
      channel: string;
      platform: string;
      hits: number;
    }>;
    const out: RetiredClientCounts = {};
    for (const r of rows) (out[r.channel] ??= {})[r.platform] = r.hits;
    return out;
  }
```

`postgres-db.ts` — append to `SCHEMA`:

```sql
CREATE TABLE IF NOT EXISTS ota_retired_clients (
  channel  text NOT NULL,
  platform text NOT NULL,
  hits     integer NOT NULL,
  PRIMARY KEY (channel, platform)
);
```

same import change, and the methods:

```ts
  async incrementRetiredClient(channel: string, platform: string): Promise<void> {
    const c = await this.ready();
    await c.query(
      `INSERT INTO ota_retired_clients (channel, platform, hits) VALUES ($1, $2, 1)
       ON CONFLICT (channel, platform) DO UPDATE SET hits = ota_retired_clients.hits + 1`,
      [channel, platform],
    );
  }

  async getRetiredClients(): Promise<RetiredClientCounts> {
    const c = await this.ready();
    const { rows } = await c.query('SELECT channel, platform, hits FROM ota_retired_clients', []);
    const out: RetiredClientCounts = {};
    for (const r of rows) (out[r.channel as string] ??= {})[r.platform as string] = Number(r.hits);
    return out;
  }
```

`redis-cache.ts` — add `get(key: string): Promise<string | null>;` to `RedisLike` and the method:

```ts
  async getToken(token: string): Promise<string | null> {
    const client = await this.client();
    return client.get(`${this.prefix}tok:${token}`);
  }
```

`s3-blob.ts` — add `import type { ByteRange } from '../http.js';`, replace `key()`, `put`, `openReadStream` and add `delete` / `deletePrefix`:

```ts
  private key(key: string): string {
    return `${this.prefix}${key}`;
  }

  async put(key: string, data: Buffer | Readable, size?: number): Promise<void> {
    const mod = await this.sdk();
    const length = Buffer.isBuffer(data) ? data.byteLength : size;
    if (length === undefined) throw new Error('S3BlobStore.put: a stream body needs an explicit size');
    await this.client(mod).send(
      new mod.PutObjectCommand({
        Bucket: this.opts.bucket,
        Key: this.key(key),
        Body: data,
        ContentLength: length,
        ContentType: 'application/octet-stream',
      }),
    );
  }

  async openReadStream(key: string, range?: ByteRange): Promise<Readable | null> {
    const mod = await this.sdk();
    try {
      const res = await this.client(mod).send(
        new mod.GetObjectCommand({
          Bucket: this.opts.bucket,
          Key: this.key(key),
          ...(range ? { Range: `bytes=${range.start}-${range.end}` } : {}),
        }),
      );
      return (res.Body as Readable) ?? null;
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    const mod = await this.sdk();
    await this.client(mod).send(new mod.DeleteObjectCommand({ Bucket: this.opts.bucket, Key: this.key(key) }));
  }

  async deletePrefix(prefix: string): Promise<void> {
    const mod = await this.sdk();
    const client = this.client(mod);
    let token: string | undefined;
    do {
      const page = (await client.send(
        new mod.ListObjectsV2Command({ Bucket: this.opts.bucket, Prefix: this.key(prefix), ContinuationToken: token }),
      )) as { Contents?: Array<{ Key?: string }>; IsTruncated?: boolean; NextContinuationToken?: string };
      const keys = (page.Contents ?? []).map((o) => o.Key).filter((k): k is string => typeof k === 'string');
      if (keys.length > 0) {
        await client.send(
          new mod.DeleteObjectsCommand({ Bucket: this.opts.bucket, Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true } }),
        );
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
  }
```

(`stat` and `get` keep their bodies; they already go through `this.key`.) Update the module JSDoc sentence "stores the encrypted bundle bytes" → "stores release blobs (`releases/<bundleId>/<sha256>`)".

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test:sqlite && npm run test:redis && npm run test:postgres && npm run test:s3`
Expected: `4 sqlite checks passed.`; the other three print their skip line (or pass if infra env is set).

- [ ] **Step 5: Commit**

```bash
git add packages/backend/src/adapters
git commit -m "feat(backend): adapters implement v2 blob keys/ranges, reusable tokens and retired-client counters"
```

---

### Task 8: Config, streamed upload spooling, and the v2 Store

**Files:**
- Modify: `packages/backend/src/config.ts`
- Create: `packages/backend/src/upload.ts`
- Modify: `packages/backend/src/store.ts`
- Create: `packages/backend/src/store.test.ts`
- Modify: `package.json` (root — `test:store`)
- Modify: `packages/backend/src/index.ts`

**Interfaces:**
- Consumes: shared `collectBlobShas`, `totalBlobBytes`, `findBlobEntry`, `bundleEntry`, `ManifestV2` (Task 4); providers (Task 6).
- Produces:
  - `BackendConfig.maxBlobBytes: number` (env `OTA_MAX_BLOB_BYTES`, default `64 * 1024 * 1024`); `downloadTokenTtlMs` default `30 * 60 * 1000`.
  - `upload.ts`: `class BlobTooLargeError extends Error { limit: number }`, `interface SpooledBlob { path: string; size: number; sha256: string; dispose(): void }`, `spoolToTemp(body: Readable, maxBytes: number): Promise<SpooledBlob>` (drains the whole body; throws `BlobTooLargeError` after draining when the cap is exceeded), `drain(body: Readable): Promise<void>`.
  - `Store`: `type StoreFailure = { ok: false; status: number; code: string; error: string; missing?: string[] }`;
    `createRelease(signedManifest, rolloutPercentage): Promise<{ ok: true; record; missing: string[] } | StoreFailure>`;
    `missingBlobs(manifest: ManifestV2): Promise<string[]>`;
    `stageBlob(bundleId, blobSha256, body: Readable, maxBytes): Promise<{ ok: true; already: boolean } | StoreFailure>`;
    `finalizeRelease(bundleId): Promise<{ ok: true; record; already: boolean } | StoreFailure>`;
    `statBlob(bundleId, blobSha256)`, `openBlobStream(bundleId, blobSha256, range?)`;
    `issueDownloadToken(bundleId, installId): Promise<string>`, `peekDownloadToken(token): Promise<{ bundleId; installId } | null>`;
    `recordRetiredClient(channel, platform)`, `getRetiredClients()`, `retiredPolicy(channel): Promise<NativeVersionPolicy>` (severity forced to `hard`);
    `pickEligible` only considers `finalized && schema === 2`.
  - Removed: `addRelease`, `statCiphertext`, `openCiphertextStream`, `consumeDownloadToken`.

- [ ] **Step 1: Write the failing test**

`packages/backend/src/store.test.ts`:

```ts
/**
 * Store-level checks over the disk/in-memory providers: the three-step release lifecycle
 * (create → stage blobs → finalize), the finalized gate in `pickEligible`, reusable download
 * tokens, and retired-client accounting. Run: `npm run test:store`.
 *
 * @module store.test
 */

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { buildReleaseV2, generateSigningKeyPair, signManifest, type DeviceContext } from '@dash-ota/shared';
import { loadConfig } from './config.js';
import { Store } from './store.js';

let passed = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const body = (buf: Buffer): Readable => Readable.from([buf]);

async function main(): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), 'dash-ota-store-'));
  const config = { ...loadConfig(), adminToken: 'x', storageDir: join(tmp, 'storage'), dataDir: join(tmp, 'data') };
  const store = new Store(config);
  const keys = generateSigningKeyPair();
  const built = await buildReleaseV2({
    bundleId: 'bnd_R2_v1',
    runtimeVersion: 'R2',
    bundleVersion: 1,
    platform: 'android',
    channel: 'dev',
    appId: 'com.example.app',
    mandatory: false,
    keyId: 'k1',
    bundlePath: 'index.android.bundle',
    files: [
      { path: 'index.android.bundle', data: Buffer.from('var x = 42;'.repeat(100), 'utf8') },
      { path: 'drawable-mdpi/logo.png', data: randomBytes(64) },
    ],
  });
  const signed = signManifest(built.manifest, keys.privateKeyPem);
  const shas = [...built.blobs.keys()];
  const device: DeviceContext = {
    platform: 'android',
    channel: 'dev',
    runtimeVersion: 'R2',
    appVersion: '1.0.0',
    buildNumber: 1,
    currentBundleVersion: 0,
    installId: 'inst-1',
  };

  console.log('dash-ota store\n');

  await check('createRelease stores an unfinalized record and lists every blob as missing', async () => {
    const res = await store.createRelease(signed, 100);
    assert.ok(res.ok);
    assert.equal(res.record.finalized, false);
    assert.equal(res.record.schema, 2);
    assert.equal(res.record.blobCount, 2);
    assert.equal(res.record.bundleSha256, built.manifest.files.find((f) => f.role === 'bundle')?.sha256);
    assert.deepEqual([...res.missing].sort(), [...shas].sort());
    assert.equal(await store.pickEligible(device), null, 'unfinalized releases are never offered');
  });

  await check('finalize refuses an incomplete release with the missing list', async () => {
    const res = await store.finalizeRelease('bnd_R2_v1');
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.status, 409);
      assert.equal(res.code, 'incomplete');
      assert.equal(res.missing?.length, 2);
    }
  });

  await check('stageBlob rejects wrong bytes, unknown ids and oversized bodies', async () => {
    const sha = shas[0]!;
    const wrong = await store.stageBlob('bnd_R2_v1', sha, body(Buffer.from('nope')), 1024);
    assert.deepEqual(wrong, { ok: false, status: 400, code: 'blob_mismatch', error: (wrong as { error: string }).error });
    const unknown = await store.stageBlob('bnd_R2_v1', 'f'.repeat(64), body(Buffer.from('x')), 1024);
    assert.equal((unknown as { code: string }).code, 'unknown_blob');
    const big = await store.stageBlob('bnd_R2_v1', sha, body(Buffer.alloc(2048, 1)), 10);
    assert.equal((big as { code: string }).code, 'blob_too_large');
    assert.equal((big as { status: number }).status, 413);
    const missing = await store.stageBlob('bnd_nope', sha, body(Buffer.from('x')), 1024);
    assert.equal((missing as { status: number }).status, 404);
  });

  await check('stageBlob stores matching bytes once and is idempotent', async () => {
    for (const sha of shas) {
      const first = await store.stageBlob('bnd_R2_v1', sha, body(built.blobs.get(sha)!), 1024 * 1024);
      assert.deepEqual(first, { ok: true, already: false });
      const again = await store.stageBlob('bnd_R2_v1', sha, body(built.blobs.get(sha)!), 1024 * 1024);
      assert.deepEqual(again, { ok: true, already: true });
      assert.deepEqual(await store.statBlob('bnd_R2_v1', sha), { size: built.blobs.get(sha)!.length });
    }
    assert.deepEqual(await store.missingBlobs(built.manifest), []);
  });

  await check('finalize flips the gate; pickEligible now offers the release; re-create is refused', async () => {
    const res = await store.finalizeRelease('bnd_R2_v1');
    assert.ok(res.ok);
    if (res.ok) assert.equal(res.already, false);
    assert.equal((await store.pickEligible(device))?.bundleId, 'bnd_R2_v1');
    const again = await store.finalizeRelease('bnd_R2_v1');
    assert.ok(again.ok && again.already);
    const recreate = await store.createRelease(signed, 50);
    assert.equal((recreate as { code: string }).code, 'already_finalized');
    const stage = await store.stageBlob('bnd_R2_v1', shas[0]!, body(built.blobs.get(shas[0]!)!), 1024 * 1024);
    assert.equal((stage as { code: string }).code, 'already_finalized');
  });

  await check('download tokens are reusable within the TTL and bound to bundle + install', async () => {
    const token = await store.issueDownloadToken('bnd_R2_v1', 'inst-1');
    assert.deepEqual(await store.peekDownloadToken(token), { bundleId: 'bnd_R2_v1', installId: 'inst-1' });
    assert.deepEqual(await store.peekDownloadToken(token), { bundleId: 'bnd_R2_v1', installId: 'inst-1' });
    assert.equal(await store.peekDownloadToken('garbage'), null);
  });

  await check('retired-client accounting and the forced-hard tombstone policy', async () => {
    await store.recordRetiredClient('dev', 'android');
    assert.deepEqual(await store.getRetiredClients(), { dev: { android: 1 } });
    assert.deepEqual(await store.retiredPolicy('dev'), { minSupportedNativeVersion: 0, severity: 'hard' });
    await store.setNativePolicy('dev', { minSupportedNativeVersion: 7, severity: 'soft', storeUrl: 'market://x' });
    assert.deepEqual(await store.retiredPolicy('dev'), { minSupportedNativeVersion: 7, severity: 'hard', storeUrl: 'market://x' });
  });

  console.log(`\n${passed} store checks passed.`);
}

void main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
```

Root `package.json`: add `"test:store": "tsx --conditions source packages/backend/src/store.test.ts",` and `npm run test:store && ` after `test:providers` in the chain.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test:store`
Expected: FAIL — `TypeError: store.createRelease is not a function`.

- [ ] **Step 3: `config.ts`**

In `BackendConfig` change the `maxBundleBytes` doc and add `maxBlobBytes` right after it:

```ts
  /** cap (bytes) on the **sum of declared blob sizes** of a release — rejected at `POST /admin/releases`. */
  maxBundleBytes: number;
  /** cap (bytes) on a single blob upload (`PUT /admin/releases/:id/blobs/:sha`), enforced while streaming. */
  maxBlobBytes: number;
```

update the `downloadTokenTtlMs` doc to `/** TTL for release-bound, reusable download tokens (ms). */`, and in `loadConfig()`:

```ts
    downloadTokenTtlMs: envNum('OTA_DL_TTL_MS', 30 * 60 * 1000),
    maxBundleBytes: envNum('OTA_MAX_BUNDLE_BYTES', 100 * 1024 * 1024),
    maxBlobBytes: envNum('OTA_MAX_BLOB_BYTES', 64 * 1024 * 1024),
```

- [ ] **Step 4: `upload.ts`**

```ts
/**
 * Streamed blob ingest. A `PUT` body is spooled to a temp file while a SHA-256 and a byte count
 * run alongside, so the backend never holds a blob in memory and can refuse an oversized upload.
 * On overflow the rest of the body is drained (not destroyed) so the client still receives the
 * 413 instead of a connection reset.
 *
 * @module upload
 */

import { createHash } from 'node:crypto';
import { createWriteStream, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/** Thrown by {@link spoolToTemp} after the body exceeded `maxBytes`. */
export class BlobTooLargeError extends Error {
  constructor(readonly limit: number) {
    super(`blob exceeds the ${limit}-byte per-blob cap`);
    this.name = 'BlobTooLargeError';
  }
}

/** A fully-received upload on disk. Call `dispose()` when done with it. */
export interface SpooledBlob {
  path: string;
  size: number;
  sha256: string;
  dispose(): void;
}

/** Read a body to the end and discard it (used before an early error reply). */
export async function drain(body: Readable): Promise<void> {
  for await (const _chunk of body) {
    // discard
  }
}

/**
 * Spool `body` to a temp file, hashing and counting as it streams. Throws {@link BlobTooLargeError}
 * once the body is fully drained if it exceeded `maxBytes` (the file is removed).
 */
export async function spoolToTemp(body: Readable, maxBytes: number): Promise<SpooledBlob> {
  const dir = mkdtempSync(join(tmpdir(), 'dash-ota-upload-'));
  const path = join(dir, 'blob.part');
  const hash = createHash('sha256');
  let size = 0;
  let tooLarge = false;
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length;
      if (tooLarge || size > maxBytes) {
        tooLarge = true;
        callback(); // keep draining, stop writing
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  const dispose = (): void => rmSync(dir, { recursive: true, force: true });
  try {
    await pipeline(body, meter, createWriteStream(path));
  } catch (err) {
    dispose();
    throw err;
  }
  if (tooLarge) {
    dispose();
    throw new BlobTooLargeError(maxBytes);
  }
  return { path, size, sha256: hash.digest('hex'), dispose };
}
```

- [ ] **Step 5: `store.ts`**

(a) Imports — replace the `@dash-ota/shared` import with:

```ts
import {
  bundleEntry,
  collectBlobShas,
  type ConfirmStatus,
  type DeviceContext,
  findBlobEntry,
  isEligible,
  type ManifestV2,
  type NativeVersionPolicy,
  type SignedManifest,
  rolloutBucket,
  randomSecretB64,
  sha256Hex,
  totalBlobBytes,
} from '@dash-ota/shared';
import { createReadStream } from 'node:fs';
import type { Readable } from 'node:stream';
import type { ByteRange } from './http.js';
import { BlobTooLargeError, drain, spoolToTemp } from './upload.js';
```

and add `releaseBlobKey, type RetiredClientCounts,` to the `./providers.js` value/type import (keep everything else it imports).

(b) Add the failure type above the class:

```ts
/** A store operation that maps directly onto an HTTP error reply. */
export type StoreFailure = { ok: false; status: number; code: string; error: string; missing?: string[] };
```

(c) Replace the `addRelease` method (the whole `// ---- releases` block up to `listReleases`) with:

```ts
  // ---- releases (three-step publish: create → stage blobs → finalize) ----

  /**
   * Create or refresh a not-yet-finalized release record from a verified signed manifest.
   * @returns the record plus the blob hashes not yet present in the blob store
   */
  async createRelease(
    signedManifest: SignedManifest,
    rolloutPercentage: number,
  ): Promise<{ ok: true; record: ReleaseRecord; missing: string[] } | StoreFailure> {
    const m = signedManifest.manifest;
    const existing = await this.db.getRelease(m.bundleId);
    if (existing?.finalized) {
      return { ok: false, status: 409, code: 'already_finalized', error: `release ${m.bundleId} is already finalized` };
    }
    const record: ReleaseRecord = {
      bundleId: m.bundleId,
      platform: m.platform,
      channel: m.channel,
      runtimeVersion: m.runtimeVersion,
      bundleVersion: m.bundleVersion,
      signedManifest,
      rolloutPercentage,
      paused: false,
      rolledBack: false,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      adoption: existing?.adoption ?? { applied: 0, healthy: 0, failed: 0, rolled_back: 0 },
      schema: 2,
      bundleSha256: bundleEntry(m)?.sha256 ?? '',
      blobCount: collectBlobShas(m).length,
      totalBytes: totalBlobBytes(m),
      finalized: false,
    };
    await this.db.putRelease(record);
    return { ok: true, record, missing: await this.missingBlobs(m) };
  }

  /** Blob hashes a manifest declares that are absent (or wrongly sized) in the blob store. */
  async missingBlobs(manifest: ManifestV2): Promise<string[]> {
    const missing: string[] = [];
    for (const sha of collectBlobShas(manifest)) {
      const expected = findBlobEntry(manifest, sha)?.size;
      const stat = await this.blob.stat(releaseBlobKey(manifest.bundleId, sha));
      if (!stat || stat.size !== expected) missing.push(sha);
    }
    return missing;
  }

  /**
   * Ingest one blob upload: spool to disk with a running hash, compare size + hash to the manifest
   * entry, then store. Idempotent — a matching blob already in place is acknowledged without a write.
   */
  async stageBlob(
    bundleId: string,
    blobSha256: string,
    body: Readable,
    maxBytes: number,
  ): Promise<{ ok: true; already: boolean } | StoreFailure> {
    const r = await this.db.getRelease(bundleId);
    if (!r) {
      await drain(body);
      return { ok: false, status: 404, code: 'not_found', error: 'release not found' };
    }
    if (r.finalized) {
      await drain(body);
      return { ok: false, status: 409, code: 'already_finalized', error: 'release is finalized' };
    }
    const expected = findBlobEntry(r.signedManifest.manifest, blobSha256)?.size;
    if (expected === undefined) {
      await drain(body);
      return { ok: false, status: 404, code: 'unknown_blob', error: 'blob is not declared by the manifest' };
    }
    const key = releaseBlobKey(bundleId, blobSha256);
    const have = await this.blob.stat(key);
    if (have && have.size === expected) {
      await drain(body);
      return { ok: true, already: true };
    }
    let spooled;
    try {
      spooled = await spoolToTemp(body, maxBytes);
    } catch (err) {
      if (err instanceof BlobTooLargeError) return { ok: false, status: 413, code: 'blob_too_large', error: err.message };
      throw err;
    }
    try {
      if (spooled.size !== expected || spooled.sha256 !== blobSha256) {
        return {
          ok: false,
          status: 400,
          code: 'blob_mismatch',
          error: `uploaded bytes do not match the manifest entry (got ${spooled.size} bytes, sha256 ${spooled.sha256})`,
        };
      }
      await this.blob.put(key, createReadStream(spooled.path), spooled.size);
      return { ok: true, already: false };
    } finally {
      spooled.dispose();
    }
  }

  /** Mark a release complete once every declared blob is present with the right size. Idempotent. */
  async finalizeRelease(bundleId: string): Promise<{ ok: true; record: ReleaseRecord; already: boolean } | StoreFailure> {
    const r = await this.db.getRelease(bundleId);
    if (!r) return { ok: false, status: 404, code: 'not_found', error: 'release not found' };
    if (r.finalized) return { ok: true, record: r, already: true };
    const missing = await this.missingBlobs(r.signedManifest.manifest);
    if (missing.length > 0) {
      return { ok: false, status: 409, code: 'incomplete', error: `${missing.length} blob(s) missing`, missing };
    }
    r.finalized = true;
    await this.db.putRelease(r);
    return { ok: true, record: r, already: false };
  }

  /** Stat one stored blob of a release, or null if absent. */
  async statBlob(bundleId: string, blobSha256: string): Promise<{ size: number } | null> {
    return this.blob.stat(releaseBlobKey(bundleId, blobSha256));
  }

  /** Stream one stored blob of a release (optionally a byte range), or null if absent. */
  async openBlobStream(bundleId: string, blobSha256: string, range?: ByteRange): Promise<Readable | null> {
    return this.blob.openReadStream(releaseBlobKey(bundleId, blobSha256), range);
  }
```

(d) Delete `statCiphertext` and `openCiphertextStream`; in `pickEligible` add as the first filter line:

```ts
      if (!r.finalized || r.schema !== 2) return false;
```

(e) Replace the `// ---- one-time download tokens` block with:

```ts
  // ---- download tokens (reusable within the TTL, bound to release + install) ----

  /** Issue a download token for `installId` scoped to `bundleId`; valid for `downloadTokenTtlMs`, reusable. */
  async issueDownloadToken(bundleId: string, installId: string): Promise<string> {
    const token = randomSecretB64(24);
    await this.cache.putToken(token, JSON.stringify({ bundleId, installId }), this.config.downloadTokenTtlMs);
    return token;
  }

  /** Resolve a download token without consuming it. */
  async peekDownloadToken(token: string): Promise<{ bundleId: string; installId: string } | null> {
    const value = await this.cache.getToken(token);
    if (!value) return null;
    try {
      const parsed = JSON.parse(value) as { bundleId?: unknown; installId?: unknown };
      if (typeof parsed.bundleId !== 'string' || typeof parsed.installId !== 'string') return null;
      return { bundleId: parsed.bundleId, installId: parsed.installId };
    } catch {
      return null;
    }
  }
```

(f) Add before `// ---- adoption + auto-pause`:

```ts
  // ---- retired protocol (v1 tombstones) ---------------------------------

  async recordRetiredClient(channel: string, platform: string): Promise<void> {
    await this.db.incrementRetiredClient(channel, platform);
  }

  async getRetiredClients(): Promise<RetiredClientCounts> {
    return this.db.getRetiredClients();
  }

  /** The channel's native policy with severity forced to `hard` — what a retired client is told. */
  async retiredPolicy(channel: string): Promise<NativeVersionPolicy> {
    const cfg = await this.db.getNativePolicy(channel);
    return {
      minSupportedNativeVersion: cfg?.minSupportedNativeVersion ?? 0,
      severity: 'hard',
      ...(cfg?.storeUrl ? { storeUrl: cfg.storeUrl } : {}),
    };
  }
```

(g) `index.ts`: add `type StoreFailure,` to the `from './store.js'` list and a new line `export { BlobTooLargeError, spoolToTemp, drain, type SpooledBlob } from './upload.js';`.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm run test:store && npm run test:providers && npm run test:http`
Expected: `7 store checks passed.` and the others green.

- [ ] **Step 7: Commit**

```bash
git add package.json packages/backend/src/config.ts packages/backend/src/upload.ts packages/backend/src/store.ts packages/backend/src/store.test.ts packages/backend/src/index.ts
git commit -m "feat(backend): v2 store — create/stage/finalize releases, streamed blob spooling, reusable download tokens"
```

---
