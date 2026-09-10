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
  type ArchiveFile,
  type BuildReleaseV2Input,
  buildReleaseV2,
  bundleEntry,
  canonicalize,
  computeRuntimeVersion,
  constantTimeEqualHex,
  generateSigningKeyPair,
  hmacSha256Hex,
  isEligible,
  publicKeyFromRawB64,
  randomAesKey,
  rolloutBucket,
  satisfiesAppVersionRange,
  signManifest,
  validateManifestShape,
  validatePath,
  verifyManifest,
  zstdFrameContentSize,
  compressForBlob,
  decompressBlob,
  verifyReleaseV2,
} from './index.js';

let passed = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

/** The files a small release is built from: a bundle, an asset, and a duplicate of that asset. */
function fixtureFiles(): ArchiveFile[] {
  const asset = Buffer.from('PNG-ish bytes that repeat across densities', 'utf8');
  return [
    { path: 'index.android.bundle', data: Buffer.from('console.log("hello from OTA bundle");'.repeat(40), 'utf8') },
    { path: 'drawable-xhdpi/logo.png', data: asset },
    // Same content at a different path: must collapse to one blob.
    { path: 'drawable-xxhdpi/logo.png', data: Buffer.from(asset) },
  ];
}

/** Fixed content key for the fixtures. Real channels hold one of these; tests must not randomise it. */
const TEST_CONTENT_KEY = Buffer.alloc(32, 7);

/** Build and sign a release, and hand back a fetcher over its blobs. */
async function makeSignedRelease(overrides: Partial<BuildReleaseV2Input> = {}) {
  const { privateKeyPem, publicKeyRawB64 } = generateSigningKeyPair();
  const files = fixtureFiles();
  const built = await buildReleaseV2({
    bundleId: 'bnd_test_1',
    runtimeVersion: 'rt_v1',
    bundleVersion: 2,
    platform: 'android',
    channel: 'dev',
    appId: 'com.example.app',
    mandatory: false,
    files,
    bundlePath: 'index.android.bundle',
    keyId: 'key_dev_1',
    contentKey: TEST_CONTENT_KEY,
    ...overrides,
  });
  const signed = signManifest(built.manifest, privateKeyPem);
  const fetchBlob = async (sha: string): Promise<Buffer> => {
    const blob = built.blobs.get(sha);
    if (!blob) throw new Error(`no such blob ${sha}`);
    return blob;
  };
  return { signed, publicKeyRawB64, built, files, fetchBlob };
}

console.log('dash-ota core self-test\n');

await check('canonicalize is key-order independent', () => {
  assert.equal(canonicalize({ b: 1, a: { d: 4, c: 3 } }), canonicalize({ a: { c: 3, d: 4 }, b: 1 }));
  assert.equal(canonicalize({ a: 2, b: 1 }), '{"a":2,"b":1}');
});

await check('Ed25519 sign → verify with embedded raw public key', async () => {
  const { signed, publicKeyRawB64 } = await makeSignedRelease();
  assert.equal(verifyManifest(signed, publicKeyFromRawB64(publicKeyRawB64)), true);
});

await check('tampered manifest fails verification (integrity / anti-injection)', async () => {
  const { signed, publicKeyRawB64 } = await makeSignedRelease();
  const tampered = { ...signed, manifest: { ...signed.manifest, bundleVersion: 999 } };
  assert.equal(verifyManifest(tampered, publicKeyFromRawB64(publicKeyRawB64)), false);
});

await check('signature from a different key is rejected (forgery)', async () => {
  const { signed } = await makeSignedRelease();
  const attacker = generateSigningKeyPair();
  assert.equal(verifyManifest(signed, publicKeyFromRawB64(attacker.publicKeyRawB64)), false);
});

await check('release roundtrip: every file comes back byte-identical', async () => {
  const { signed, publicKeyRawB64, fetchBlob, files } = await makeSignedRelease();
  const out = await verifyReleaseV2(signed, fetchBlob, publicKeyFromRawB64(publicKeyRawB64));
  assert.equal(out.files.length, files.length);
  for (const original of files) {
    const got = out.files.find((f) => f.path === original.path);
    assert.ok(got, `missing ${original.path}`);
    assert.deepEqual(got.data, original.data);
  }
});

await check('identical files share one blob (dedup within a release)', async () => {
  const { built } = await makeSignedRelease();
  assert.equal(built.manifest.files.length, 3);
  assert.equal(built.blobs.size, 2, 'the duplicated asset must not be stored twice');
  const a = built.manifest.files.find((f) => f.path === 'drawable-xhdpi/logo.png');
  const b = built.manifest.files.find((f) => f.path === 'drawable-xxhdpi/logo.png');
  assert.equal(a?.blob.sha256, b?.blob.sha256);
  assert.equal(a?.sha256, b?.sha256);
});

await check('the bundle is compressed and marked; the manifest carries no payload bytes', async () => {
  const { built, signed } = await makeSignedRelease();
  const bundle = bundleEntry(built.manifest);
  assert.ok(bundle);
  assert.equal(bundle.blob.compression, 'zstd');
  assert.ok(bundle.blob.size < bundle.size, 'compressed blob should be smaller than the plaintext');
  // A manifest that embedded the payload would be enormous and would defeat the point.
  assert.ok(JSON.stringify(signed.manifest).length < 4096);
  assert.equal(JSON.stringify(signed.manifest).includes('stored'), false);
});

await check('a tampered blob is rejected before it is decrypted', async () => {
  const { signed, publicKeyRawB64, built } = await makeSignedRelease();
  const evil = async (sha: string): Promise<Buffer> => {
    const good = built.blobs.get(sha);
    assert.ok(good);
    const flipped = Buffer.from(good);
    flipped[0] = (flipped[0] ?? 0) ^ 0xff;
    return flipped;
  };
  await assert.rejects(() => verifyReleaseV2(signed, evil, publicKeyFromRawB64(publicKeyRawB64)), /hash mismatch/);
});

// Convergent encryption means two releases containing the same file DO produce the same blob —
// that sharing is the point, and the pair of checks below pins both halves of it: bytes sealed
// under this channel's key are interchangeable, bytes sealed under any other key are not.
await check('the same file seals to the same blob in every release (cross-release dedup)', async () => {
  const a = await makeSignedRelease({ bundleId: 'bnd_a' });
  const b = await makeSignedRelease({ bundleId: 'bnd_b' });
  const shaByPath = (r: typeof a) => new Map(r.signed.manifest.files.map((f) => [f.path, f.blob.sha256]));
  const [sa, sb] = [shaByPath(a), shaByPath(b)];
  assert.deepEqual([...sa.keys()].sort(), [...sb.keys()].sort());
  for (const [path, sha] of sa) {
    assert.equal(sb.get(path), sha, `${path} sealed differently in a second release — dedup is broken`);
  }
  // And the bytes really are identical, not merely equally named.
  for (const [sha, bytes] of a.built.blobs) assert.deepEqual(b.built.blobs.get(sha), bytes);
});

await check('a blob sealed under a different content key is rejected', async () => {
  const { publicKeyRawB64, signed } = await makeSignedRelease();
  const other = await makeSignedRelease({ bundleId: 'bnd_other', contentKey: Buffer.alloc(32, 9) });
  // Serve the other channel's blobs relabelled with this manifest's hashes, so the cheap checks
  // pass and only the AEAD can catch it.
  const swap = async (sha: string): Promise<Buffer> => {
    const mine = signed.manifest.files.find((f) => f.blob.sha256 === sha);
    assert.ok(mine);
    const theirs = other.signed.manifest.files.find((f) => f.path === mine.path);
    assert.ok(theirs);
    const bytes = other.built.blobs.get(theirs.blob.sha256);
    assert.ok(bytes);
    return bytes;
  };
  await assert.rejects(() => verifyReleaseV2(signed, swap, publicKeyFromRawB64(publicKeyRawB64)));
});

await check('unencrypted releases still verify, and carry no iv/tag', async () => {
  const { signed, publicKeyRawB64, fetchBlob, files } = await makeSignedRelease({ encrypt: false });
  assert.equal(signed.manifest.encryption.mode, 'none');
  for (const f of signed.manifest.files) {
    assert.equal(f.blob.ivB64, undefined);
    assert.equal(f.blob.tagB64, undefined);
  }
  const out = await verifyReleaseV2(signed, fetchBlob, publicKeyFromRawB64(publicKeyRawB64));
  assert.equal(out.files.length, files.length);
});

await check('edge cases: empty file, incompressible bytes, and a unicode path', async () => {
  const { privateKeyPem, publicKeyRawB64 } = generateSigningKeyPair();
  // Random bytes do not compress; an empty file has nothing to compress. Both must survive the
  // "only keep compression if it saves something" rule and come back byte-identical.
  const files: ArchiveFile[] = [
    { path: 'index.android.bundle', data: Buffer.from('x'.repeat(500), 'utf8') },
    { path: 'empty.txt', data: Buffer.alloc(0) },
    { path: 'noise.bin', data: randomBytes(4096) },
    { path: 'assets/ünïcode ᛒ/ok.txt', data: Buffer.from('unicode path', 'utf8') },
  ];
  const built = await buildReleaseV2({
    bundleId: 'bnd_edge',
    runtimeVersion: 'rt',
    bundleVersion: 1,
    platform: 'ios',
    channel: 'prod',
    appId: 'com.example.app',
    mandatory: false,
    files,
    bundlePath: 'index.android.bundle',
    keyId: 'k',
    contentKey: TEST_CONTENT_KEY,
  });
  assert.deepEqual(validateManifestShape(built.manifest), []);
  const empty = built.manifest.files.find((f) => f.path === 'empty.txt');
  assert.equal(empty?.size, 0);
  assert.equal(empty?.blob.compression, 'none');
  assert.equal(built.manifest.files.find((f) => f.path === 'noise.bin')?.blob.compression, 'none');

  const signed = signManifest(built.manifest, privateKeyPem);
  const out = await verifyReleaseV2(
    signed,
    async (sha) => {
      const b = built.blobs.get(sha);
      assert.ok(b);
      return b;
    },
    publicKeyFromRawB64(publicKeyRawB64),
  );
  for (const original of files) {
    const got = out.files.find((f) => f.path === original.path);
    assert.ok(got, `missing ${original.path}`);
    assert.deepEqual(got.data, original.data);
  }
});

await check('AES-GCM rejects a wrong key and a flipped byte', () => {
  const key = randomAesKey();
  const enc = aesGcmEncrypt(key, Buffer.from('secret'), Buffer.from('aad'));
  assert.throws(() => aesGcmDecrypt(randomAesKey(), enc.ivB64, enc.ciphertext, enc.tagB64, Buffer.from('aad')));
  assert.throws(() => aesGcmDecrypt(key, enc.ivB64, enc.ciphertext, enc.tagB64, Buffer.from('other-aad')));
  const flipped = Buffer.from(enc.ciphertext);
  flipped[0] = (flipped[0] ?? 0) ^ 0xff;
  assert.throws(() => aesGcmDecrypt(key, enc.ivB64, flipped, enc.tagB64, Buffer.from('aad')));
});

await check('a decompression bomb is refused before anything is allocated', async () => {
  const { privateKeyPem, publicKeyRawB64 } = generateSigningKeyPair();
  const files: ArchiveFile[] = [{ path: 'index.android.bundle', data: Buffer.from('real bundle'.repeat(50), 'utf8') }];
  const built = await buildReleaseV2({
    bundleId: 'bnd_bomb',
    runtimeVersion: 'rt',
    bundleVersion: 1,
    platform: 'android',
    channel: 'dev',
    appId: 'com.example.app',
    mandatory: false,
    files,
    bundlePath: 'index.android.bundle',
    keyId: 'k',
    encrypt: false,
  });
  const signed = signManifest(built.manifest, privateKeyPem);
  const entry = built.manifest.files[0];
  assert.ok(entry);

  // 64 MB of zeros compresses to a couple of KB. A publisher that served this in place of the real
  // blob would, without the frame-size check, expand it in full before comparing against `size`.
  const bomb = await compressForBlob(Buffer.alloc(64 * 1024 * 1024), 'index.android.bundle', 3);
  assert.equal(bomb.compression, 'zstd');
  assert.ok(bomb.data.length < 100 * 1024, 'the bomb should be tiny on the wire');
  assert.equal(zstdFrameContentSize(bomb.data), 64 * 1024 * 1024);

  // Through the whole pipeline the bomb never reaches the decompressor at all: the blob's stored
  // size is signed too, so it is refused one layer earlier than the frame check.
  await assert.rejects(
    () => verifyReleaseV2(signed, async () => bomb.data, publicKeyFromRawB64(publicKeyRawB64)),
    /size \d+ != \d+/,
  );

  // The frame-size gate itself, isolated: this is the layer that protects a caller who already
  // holds bytes whose stored size and hash are both correct for the entry.
  await assert.rejects(() => decompressBlob(bomb.data, 'zstd', entry.size), /declares 67108864 bytes/);
  // A frame with no declared size is refused outright rather than trusted.
  await assert.rejects(() => decompressBlob(Buffer.from('not a zstd frame'), 'zstd', 10), /declares no content size/);
});

await check('path rules reject traversal, absolute and malformed paths', () => {
  assert.equal(validatePath('drawable-xxhdpi/logo.png'), null);
  assert.equal(validatePath('index.android.bundle'), null);
  for (const bad of ['../escape', 'a/../b', '/etc/passwd', 'a//b', './x', 'a\\b', 'C:/x', '', 'a/\u0000b']) {
    assert.notEqual(validatePath(bad), null, `expected ${JSON.stringify(bad)} to be rejected`);
  }
  assert.notEqual(validatePath('x'.repeat(513)), null);
});

await check('manifest validation catches the mistakes that would reach a device', async () => {
  const { signed } = await makeSignedRelease();
  assert.deepEqual(validateManifestShape(signed.manifest), []);

  const noBundle = { ...signed.manifest, files: signed.manifest.files.map((f) => ({ ...f, role: undefined })) };
  assert.ok(validateManifestShape(noBundle).some((e) => e.includes('exactly one file')));

  const traversal = {
    ...signed.manifest,
    files: signed.manifest.files.map((f, i) => (i === 0 ? { ...f, path: '../escape' } : f)),
  };
  assert.ok(validateManifestShape(traversal).some((e) => e.includes('".." segment')));

  const v1 = { ...signed.manifest, schema: 1 };
  assert.ok(validateManifestShape(v1).some((e) => e.includes('schema must be 2')));

  const noPatches = { ...signed.manifest, patches: undefined };
  assert.ok(validateManifestShape(noPatches).some((e) => e.includes('patches must be an array')));
});

await check('HMAC-SHA256 primitive is deterministic + constant-time compared', () => {
  const key = Buffer.from('mac-key').toString('base64');
  const a = hmacSha256Hex(key, 'POST/ota/v1/check|nonce|123');
  const b = hmacSha256Hex(key, 'POST/ota/v1/check|nonce|123');
  assert.equal(constantTimeEqualHex(a, b), true);
  assert.equal(constantTimeEqualHex(a, hmacSha256Hex(key, 'tampered')), false);
});

await check('eligibility: runtimeVersion gate blocks cross-generation OTA (the store-vs-OTA bug)', async () => {
  const { signed } = await makeSignedRelease({ runtimeVersion: 'R2', bundleVersion: 5 });
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
  const { signed } = await makeSignedRelease({
    runtimeVersion: 'R2',
    bundleVersion: 3,
    targetAppVersions: '>=1.2.0 <1.3.0',
  });
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
  assert.notEqual(rolloutBucket('install-A', 'bnd_1'), rolloutBucket('install-Z', 'bnd_1') - 0.5);
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
