/**
 * Self-test for the crypto/protocol core. Proves the security guarantees the whole system
 * rests on, with no server or device needed. Run: `npm run test:core`.
 *
 * @module selftest
 */

import assert from 'node:assert/strict';
import {
  aesGcmDecrypt,
  aesGcmEncrypt,
  canonicalize,
  computeRuntimeVersion,
  constantTimeEqualHex,
  generateSigningKeyPair,
  hmacSha256Hex,
  isEligible,
  type Manifest,
  publicKeyFromRawB64,
  randomAesKey,
  rolloutBucket,
  satisfiesAppVersionRange,
  sha256Hex,
  signManifest,
  validateManifestShape,
  verifyManifest,
} from './index.js';

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

/** Build a fully-formed, signed manifest over a fake encrypted bundle. */
function makeSignedBundle(overrides: Partial<Manifest> = {}) {
  const { privateKeyPem, publicKeyRawB64 } = generateSigningKeyPair();
  const plaintext = Buffer.from('console.log("hello from OTA bundle");', 'utf8');
  const key = randomAesKey();
  const enc = aesGcmEncrypt(key, plaintext);
  const manifest: Manifest = {
    schema: 1,
    bundleId: 'bnd_test_1',
    runtimeVersion: 'rt_v1',
    bundleVersion: 2,
    platform: 'android',
    channel: 'dev',
    createdAt: new Date('2026-06-18T00:00:00.000Z').toISOString(),
    mandatory: false,
    files: [{ path: 'index.android.bundle', sha256: sha256Hex(plaintext), size: plaintext.length }],
    encryption: {
      algo: 'AES-256-GCM',
      ivB64: enc.ivB64,
      tagB64: enc.tagB64,
      contentKeyB64: key.toString('base64'),
      ciphertextSha256: sha256Hex(enc.ciphertext),
      ciphertextSize: enc.ciphertext.length,
    },
    keyId: 'key_dev_1',
    ...overrides,
  };
  const signed = signManifest(manifest, privateKeyPem);
  return { signed, publicKeyRawB64, key, ciphertext: enc.ciphertext, plaintext };
}

console.log('dash-ota core self-test\n');

check('canonicalize is key-order independent', () => {
  assert.equal(canonicalize({ b: 1, a: { d: 4, c: 3 } }), canonicalize({ a: { c: 3, d: 4 }, b: 1 }));
  assert.equal(canonicalize({ a: 2, b: 1 }), '{"a":2,"b":1}');
});

check('Ed25519 sign → verify with embedded raw public key', () => {
  const { signed, publicKeyRawB64 } = makeSignedBundle();
  const embeddedKey = publicKeyFromRawB64(publicKeyRawB64);
  assert.equal(verifyManifest(signed, embeddedKey), true);
});

check('tampered manifest fails verification (integrity / anti-injection)', () => {
  const { signed, publicKeyRawB64 } = makeSignedBundle();
  const embeddedKey = publicKeyFromRawB64(publicKeyRawB64);
  const tampered = { ...signed, manifest: { ...signed.manifest, bundleVersion: 999 } };
  assert.equal(verifyManifest(tampered, embeddedKey), false);
});

check('signature from a different key is rejected (forgery)', () => {
  const { signed } = makeSignedBundle();
  const attacker = generateSigningKeyPair();
  assert.equal(verifyManifest(signed, publicKeyFromRawB64(attacker.publicKeyRawB64)), false);
});

check('AES-256-GCM roundtrip recovers the bundle', () => {
  const { key, ciphertext, plaintext, signed } = makeSignedBundle();
  const out = aesGcmDecrypt(key, signed.manifest.encryption.ivB64, ciphertext, signed.manifest.encryption.tagB64);
  assert.deepEqual(out, plaintext);
});

check('AES-GCM rejects wrong key and tampered ciphertext', () => {
  const { ciphertext, signed } = makeSignedBundle();
  const { ivB64, tagB64 } = signed.manifest.encryption;
  assert.throws(() => aesGcmDecrypt(randomAesKey(), ivB64, ciphertext, tagB64));
  const flipped = Buffer.from(ciphertext);
  flipped[0] = (flipped[0] ?? 0) ^ 0xff;
  const realKey = Buffer.from(signed.manifest.encryption.contentKeyB64, 'base64');
  assert.throws(() => aesGcmDecrypt(realKey, ivB64, flipped, tagB64));
});

check('per-file sha256 detects a swapped asset', () => {
  const { plaintext, signed } = makeSignedBundle();
  const fileHash = signed.manifest.files[0]?.sha256;
  assert.equal(fileHash, sha256Hex(plaintext));
  assert.notEqual(fileHash, sha256Hex(Buffer.from('malicious', 'utf8')));
});

check('HMAC request signing is deterministic + constant-time compared', () => {
  const secret = Buffer.from('per-install-secret').toString('base64');
  const a = hmacSha256Hex(secret, 'POST/ota/v1/check|nonce|123');
  const b = hmacSha256Hex(secret, 'POST/ota/v1/check|nonce|123');
  assert.equal(constantTimeEqualHex(a, b), true);
  assert.equal(constantTimeEqualHex(a, hmacSha256Hex(secret, 'tampered')), false);
});

check('manifest shape validation catches malformed input', () => {
  const { signed } = makeSignedBundle();
  assert.deepEqual(validateManifestShape(signed.manifest), []);
  assert.ok(validateManifestShape({ schema: 2 }).length > 0);
});

check('eligibility: runtimeVersion gate blocks cross-generation OTA (the store-vs-OTA bug)', () => {
  const { signed } = makeSignedBundle({ runtimeVersion: 'R2', bundleVersion: 5 });
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

check('eligibility: downgrade guard + app-version range', () => {
  const { signed } = makeSignedBundle({ runtimeVersion: 'R2', bundleVersion: 3, targetAppVersions: '>=1.2.0 <1.3.0' });
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
  assert.equal(isEligible(signed.manifest, { ...base, currentBundleVersion: 2, appVersion: '1.3.1' }).reason, 'app-version-excluded');
});

check('semver-subset range matching', () => {
  assert.equal(satisfiesAppVersionRange('1.2.5', '>=1.2.0 <1.3.0'), true);
  assert.equal(satisfiesAppVersionRange('1.3.0', '>=1.2.0 <1.3.0'), false);
  assert.equal(satisfiesAppVersionRange('1.2.9', '1.2.x'), true);
  assert.equal(satisfiesAppVersionRange('1.4.0', '1.2.x'), false);
  assert.equal(satisfiesAppVersionRange('9.9.9', '*'), true);
});

check('rollout bucket is deterministic and in range', () => {
  const a = rolloutBucket('install-A', 'bnd_1');
  assert.equal(a, rolloutBucket('install-A', 'bnd_1'));
  assert.ok(a >= 0 && a < 100);
  assert.notEqual(rolloutBucket('install-A', 'bnd_1'), rolloutBucket('install-Z', 'bnd_1') - 0.5);
});

check('runtimeVersion fingerprint: stable + changes on native input change', () => {
  const base = {
    nativeDependencies: ['react-native-reanimated@4.0.0', 'react-native-dash-ota@0.1.0'],
    nativeDirHashes: { android: 'aa', ios: 'bb' },
    hermesVersion: '0.12.0',
    reactNativeVersion: '0.79.2',
  };
  assert.equal(computeRuntimeVersion(base), computeRuntimeVersion({ ...base, nativeDependencies: [...base.nativeDependencies].reverse() }));
  assert.notEqual(computeRuntimeVersion(base), computeRuntimeVersion({ ...base, hermesVersion: '0.13.0' }));
});

console.log(`\n${passed} checks passed.`);
