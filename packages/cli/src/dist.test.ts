/**
 * Distribution tests — they exercise the **built artifacts**, never `src/`.
 *
 * Every other suite runs under `--conditions source`, so `@dash-ota/shared` resolves to its
 * TypeScript. That is fast, but it means a stale or broken `dist/` stays invisible: the gate can
 * be green while `npx dash-ota` still speaks the previous wire format. These checks close that
 * gap by running the real binary and reading what it produces.
 *
 * Run: `npm run test:dist` (after `npm run build`).
 *
 * @module dist.test
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const binary = join(repoRoot, 'packages', 'cli', 'dist', 'index.mjs');

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

/** Run the built CLI. Returns stdout; throws with stderr attached on a non-zero exit. */
function runCli(args: string[], cwd: string): string {
  return execFileSync(process.execPath, [binary, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, OTA_ADMIN_TOKEN: '' },
  });
}

console.log('\ndash-ota distribution artifacts\n');

check('the shared package builds to dist and exports the v2 API', () => {
  const dist = join(repoRoot, 'packages', 'shared', 'dist');
  assert.ok(existsSync(join(dist, 'index.js')), 'shared/dist/index.js is missing — run npm run build');
  const index = readFileSync(join(dist, 'index.js'), 'utf8');
  for (const symbol of ['release.js', 'compression.js', 'paths.js']) {
    assert.ok(index.includes(symbol), `shared/dist/index.js does not re-export ${symbol}`);
  }
  // archive.ts was deleted with the v1 format. Its presence means a stale compile.
  assert.ok(!existsSync(join(dist, 'archive.js')), 'shared/dist/archive.js survives — dist is a stale v1 compile');
});

check('the CLI binary exists and runs', () => {
  assert.ok(existsSync(binary), 'packages/cli/dist/index.mjs is missing — run npm run build');
  // No args prints usage and exits non-zero, so read it off the failure.
  let usage: string;
  try {
    usage = runCli([], repoRoot);
  } catch (error) {
    usage = String((error as { stdout?: string }).stdout ?? '');
  }
  assert.ok(usage.includes('dash-ota <command>'), 'binary did not print usage');
  assert.ok(usage.includes('--app-id'), 'binary usage has no --app-id — this is a pre-v2 build');
});

check('keygen never prompts without --interactive', () => {
  const work = mkdtempSync(join(tmpdir(), 'dash-ota-keygen-'));
  const out = runCli(['keygen', '--out', join(work, '.keys'), '--key-id', 'key_quiet', '--no-encrypt'], work);
  // The prompt used to be unconditional: under a TTY that hangs a CI keygen forever, and it only
  // looked harmless here because execFileSync hands the child a closed stdin.
  assert.ok(!out.includes('Register this public key'), 'keygen asked a question in non-interactive mode');
  assert.ok(existsSync(join(work, '.keys', 'key_quiet.private.pem')), 'keygen wrote no private key');
});

check('keygen refuses to replace an existing signing key', () => {
  const work = mkdtempSync(join(tmpdir(), 'dash-ota-keyguard-'));
  const keys = join(work, '.keys');
  runCli(['keygen', '--out', keys, '--key-id', 'key_live', '--no-encrypt'], work);
  const original = readFileSync(join(keys, 'key_live.private.pem'), 'utf8');

  // Overwriting it would invalidate every release for every app embedding the matching public key,
  // recoverable only by shipping a new store build. It must not be possible by accident.
  let refused = false;
  try {
    runCli(['keygen', '--out', keys, '--key-id', 'key_live', '--no-encrypt'], work);
  } catch {
    refused = true;
  }
  assert.ok(refused, 'a second keygen for the same key id must fail');
  assert.equal(readFileSync(join(keys, 'key_live.private.pem'), 'utf8'), original, 'the signing key changed');

  // --force is the deliberate escape hatch.
  runCli(['keygen', '--out', keys, '--key-id', 'key_live', '--no-encrypt', '--force'], work);
  assert.notEqual(readFileSync(join(keys, 'key_live.private.pem'), 'utf8'), original, '--force should rotate');
});

check('keygen can add a missing content key without touching the signing key', () => {
  const work = mkdtempSync(join(tmpdir(), 'dash-ota-contentonly-'));
  const keys = join(work, '.keys');
  runCli(['keygen', '--out', keys, '--key-id', 'key_old', '--no-encrypt'], work);
  const signing = readFileSync(join(keys, 'key_old.private.pem'), 'utf8');

  // Simulate a channel created before content keys existed.
  rmSync(join(keys, 'key_old.content.key'));
  runCli(['keygen', '--out', keys, '--key-id', 'key_old', '--content-key-only'], work);

  assert.ok(existsSync(join(keys, 'key_old.content.key')), 'the content key should be created');
  assert.equal(readFileSync(join(keys, 'key_old.private.pem'), 'utf8'), signing, 'the signing key must be untouched');
  assert.equal(Buffer.from(readFileSync(join(keys, 'key_old.content.key'), 'utf8').trim(), 'base64').length, 32);
});

check('the binary publishes a schema-2 release offline', () => {
  const work = mkdtempSync(join(tmpdir(), 'dash-ota-dist-'));
  const bundleDir = join(work, 'bundle');
  mkdirSync(join(bundleDir, 'drawable-xxhdpi'), { recursive: true });
  writeFileSync(join(bundleDir, 'index.android.bundle'), 'x'.repeat(4096));
  writeFileSync(join(bundleDir, 'drawable-xxhdpi', 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]));

  runCli(['keygen', '--out', join(work, '.keys'), '--key-id', 'key_dist_1', '--no-encrypt'], work);
  runCli(
    [
      'publish',
      '--bundle-dir',
      bundleDir,
      '--platform',
      'android',
      '--channel',
      'dev',
      '--runtime-version',
      'r_dist',
      '--bundle-version',
      '1',
      '--bundle-id',
      'bnd_dist_1',
      '--app-id',
      'com.example.dist',
      '--key-id',
      'key_dist_1',
      '--key',
      join(work, '.keys', 'key_dist_1.private.pem'),
      '--no-upload',
    ],
    work,
  );

  const out = join(work, 'bnd_dist_1.v2');
  const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8')) as {
    manifest: { schema: number; appId: string; files: { path: string; sha256: string; blob: { sha256: string } }[] };
  };
  assert.equal(manifest.manifest.schema, 2, 'the binary emitted a non-v2 manifest');
  assert.equal(manifest.manifest.appId, 'com.example.dist');
  assert.equal(manifest.manifest.files.length, 2);
  // One blob file per distinct plaintext, named by the blob hash.
  for (const file of manifest.manifest.files) {
    assert.ok(existsSync(join(out, 'blobs', file.blob.sha256)), `blob for ${file.path} was not written`);
  }
});

console.log(`\n${passed} distribution checks passed.\n`);
