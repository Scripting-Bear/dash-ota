/**
 * CLI unit tests — the release trust root. Covers arg parsing, the secure-server / fail-closed
 * admin guards, the passphrase key-custody roundtrip (encrypt → decrypt → sign → verify), and the
 * content-hash runtimeVersion fingerprint (incl. the same-size-different-content case that the old
 * path+size hash missed). Pure/offline — no server, no network. Run: `npm run test:cli`.
 *
 * @module cli.test
 */

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRelease, generateSigningKeyPair, publicKeyFromRawB64, signManifest, verifyManifest } from '@dash-ota/shared';
import {
  assertSecureServer,
  decryptPrivateKeyPem,
  encryptPrivateKeyPem,
  fingerprintProject,
  flagBool,
  flagStr,
  isEncryptedPem,
  parseArgs,
  readBundleDir,
  resolveServer,
  resolveVerifyKey,
} from './util.js';

let passed = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

/** Write a minimal fake RN project under a fresh temp dir; returns its path. */
function fakeProject(androidContent: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'dash-ota-cli-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { 'react-native': '0.79.2' } }));
  mkdirSync(join(dir, 'android', 'app'), { recursive: true });
  mkdirSync(join(dir, 'ios'), { recursive: true });
  writeFileSync(join(dir, 'android', 'app', 'build.gradle'), androidContent);
  writeFileSync(join(dir, 'ios', 'AppDelegate.mm'), 'ios-native');
  return dir;
}

async function main(): Promise<void> {
  console.log('dash-ota cli unit tests\n');

  await check('parseArgs handles positionals, --k v, --k=v, and bare flags', () => {
    const a = parseArgs(['publish', '--platform', 'ios', '--rollout=50', '--mandatory']);
    assert.equal(a._[0], 'publish');
    assert.equal(flagStr(a, 'platform'), 'ios');
    assert.equal(flagStr(a, 'rollout'), '50');
    assert.equal(flagBool(a, 'mandatory'), true);
    assert.equal(flagBool(a, 'missing'), false);
  });

  await check('assertSecureServer allows localhost/https, refuses remote http', () => {
    assertSecureServer('http://localhost:4455', false);
    assertSecureServer('http://127.0.0.1:4455', false);
    assertSecureServer('https://ota.example.com', false);
    assertSecureServer('http://ota.example.com', true); // explicit escape hatch
    assert.throws(() => assertSecureServer('http://ota.example.com', false), /plaintext http/);
    assert.throws(() => assertSecureServer('not a url', false), /invalid --server/);
  });

  await check('resolveServer is fail-closed on the admin token (no default)', () => {
    const saved = process.env.OTA_ADMIN_TOKEN;
    delete process.env.OTA_ADMIN_TOKEN;
    try {
      assert.throws(() => resolveServer(parseArgs(['list'])), /admin token required/);
      const ok = resolveServer(parseArgs(['list', '--admin-token', 'secret', '--server', 'https://x.example.com']));
      assert.equal(ok.adminToken, 'secret');
    } finally {
      if (saved !== undefined) process.env.OTA_ADMIN_TOKEN = saved;
    }
  });

  await check('key custody: encrypt → decrypt → sign → verify roundtrip', () => {
    const kp = generateSigningKeyPair();
    assert.equal(isEncryptedPem(kp.privateKeyPem), false);
    const enc = encryptPrivateKeyPem(kp.privateKeyPem, 'hunter2');
    assert.equal(isEncryptedPem(enc), true);
    const dec = decryptPrivateKeyPem(enc, 'hunter2');

    const { manifest } = buildRelease({
      bundleId: 'bnd_cli',
      runtimeVersion: 'R2',
      bundleVersion: 1,
      platform: 'android',
      channel: 'dev',
      mandatory: false,
      files: [{ path: 'index.android.bundle', data: Buffer.from('x=1', 'utf8') }],
      keyId: 'key_dev_1',
    });
    const signed = signManifest(manifest, dec);
    assert.ok(verifyManifest(signed, publicKeyFromRawB64(kp.publicKeyRawB64)), 'decrypted key must produce a valid signature');
    assert.throws(() => decryptPrivateKeyPem(enc, 'wrong-passphrase'));
  });

  await check('resolveVerifyKey: sibling .public.json, --verify-pub, and safe fallback (no crash)', () => {
    const kp = generateSigningKeyPair();
    const dir = mkdtempSync(join(tmpdir(), 'dash-ota-verify-'));
    const keyPath = join(dir, 'key_dev_1.private.pem');
    writeFileSync(keyPath, kp.privateKeyPem);
    writeFileSync(
      join(dir, 'key_dev_1.public.json'),
      JSON.stringify({ keyId: 'key_dev_1', publicKeyRawB64: kp.publicKeyRawB64 }),
    );
    const { manifest } = buildRelease({
      bundleId: 'bnd_v',
      runtimeVersion: 'R2',
      bundleVersion: 1,
      platform: 'android',
      channel: 'dev',
      mandatory: false,
      files: [{ path: 'index.android.bundle', data: Buffer.from('x=1', 'utf8') }],
      keyId: 'key_dev_1',
    });
    const signed = signManifest(manifest, kp.privateKeyPem);

    const viaSibling = resolveVerifyKey(parseArgs([]), keyPath, kp.privateKeyPem);
    assert.match(viaSibling.source, /public\.json$/);
    assert.ok(verifyManifest(signed, viaSibling.key));

    const viaFlag = resolveVerifyKey(parseArgs(['--verify-pub', kp.publicKeyRawB64]), keyPath, kp.privateKeyPem);
    assert.equal(viaFlag.source, '--verify-pub');
    assert.ok(verifyManifest(signed, viaFlag.key));

    // custom --key path NOT ending in .private.pem, no sibling → safe fallback, must not crash
    const custom = join(dir, 'mykey.pem');
    writeFileSync(custom, kp.privateKeyPem);
    const viaFallback = resolveVerifyKey(parseArgs([]), custom, kp.privateKeyPem);
    assert.match(viaFallback.source, /consistency check/);
    assert.ok(verifyManifest(signed, viaFallback.key));
  });

  await check('readBundleDir reads files with POSIX relative paths', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dash-ota-bundle-'));
    mkdirSync(join(dir, 'assets'), { recursive: true });
    writeFileSync(join(dir, 'index.android.bundle'), 'BUNDLE');
    writeFileSync(join(dir, 'assets', 'logo.txt'), 'LOGO');
    const files = readBundleDir(dir);
    assert.equal(files.length, 2);
    assert.ok(files.some((f) => f.path === 'assets/logo.txt'));
  });

  await check('fingerprint is deterministic and content-sensitive (same size, different bytes)', () => {
    const p1 = fakeProject('AAAA');
    const p2 = fakeProject('AAAA');
    const p3 = fakeProject('BBBB'); // same length as AAAA — the case the old path+size hash missed
    const rv1 = fingerprintProject(p1).runtimeVersion;
    const rv2 = fingerprintProject(p2).runtimeVersion;
    const rv3 = fingerprintProject(p3).runtimeVersion;
    assert.equal(rv1, rv2, 'identical projects → identical runtimeVersion');
    assert.notEqual(rv1, rv3, 'a same-size content change MUST flip the runtimeVersion');
  });

  console.log(`\n${passed} cli checks passed.`);
}

void main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
