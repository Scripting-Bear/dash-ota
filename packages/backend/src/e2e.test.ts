/**
 * End-to-end test against the real HTTP server: publish → check → download → verify+decrypt,
 * plus the attack/edge cases that matter (runtimeVersion gate, replay, one-time token, bad
 * signature, auto-pause). Run: `npm run test:e2e`.
 *
 * @module e2e.test
 */

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type ArchiveFile,
  buildRelease,
  type CheckResponse,
  generateSigningKeyPair,
  openRelease,
  OTA_HEADERS,
  publicKeyFromRawB64,
  randomNonceB64,
  requestSigningString,
  sha256Hex,
  signManifest,
} from '@dash-ota/shared';
import { generateKeyPairSync, type KeyObject, sign as nodeSign } from 'node:crypto';
import { loadConfig } from './config.js';
import { createRouter } from './server.js';
import { Store } from './store.js';

const ADMIN = 'test-admin-token';
let passed = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

interface Install {
  id: string;
  /** the simulated device's hardware EC P-256 private key. */
  privateKey: KeyObject;
}

/** Sign the canonical request string with a device's EC key (ECDSA-P256-SHA256, DER → base64). */
function deviceSign(privateKey: KeyObject, signingStr: string): string {
  return nodeSign('sha256', Buffer.from(signingStr, 'utf8'), privateKey).toString('base64');
}

async function main(): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), 'dash-ota-e2e-'));
  const config = {
    ...loadConfig(),
    port: 0,
    adminToken: ADMIN,
    storageDir: join(tmp, 'storage'),
    dataDir: join(tmp, 'data'),
    autoPauseMinSamples: 2,
    autoPauseFailureRate: 0.2,
    requireRequestSignature: true,
  };
  const store = new Store(config);
  const router = createRouter(store, config);
  const server: Server = await router.listen(0);
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  const base = `http://localhost:${port}`;

  // CLI role: generate signing keypair; backend trusts only the public key.
  const keys = generateSigningKeyPair();
  const keyId = 'key_dev_1';
  const embeddedPublicKey = publicKeyFromRawB64(keys.publicKeyRawB64);

  /** Sign + send a client request the way the RN client will (device-key ECDSA). */
  async function signedPost(path: string, body: unknown, install: Install): Promise<Response> {
    const raw = Buffer.from(JSON.stringify(body), 'utf8');
    const nonce = randomNonceB64();
    const timestamp = String(Date.now());
    const signature = deviceSign(
      install.privateKey,
      requestSigningString({ method: 'POST', path, installId: install.id, nonce, timestamp, bodySha256: sha256Hex(raw) }),
    );
    return fetch(`${base}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [OTA_HEADERS.installId]: install.id,
        [OTA_HEADERS.nonce]: nonce,
        [OTA_HEADERS.timestamp]: timestamp,
        [OTA_HEADERS.signature]: signature,
      },
      body: raw,
    });
  }

  async function adminPost(path: string, body: unknown): Promise<Response> {
    return fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ota-admin-token': ADMIN },
      body: JSON.stringify(body),
    });
  }

  async function enroll(id: string, runtimeVersion: string): Promise<Install> {
    void runtimeVersion;
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const devicePublicKeyB64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    const res = await fetch(`${base}/ota/v1/enroll`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ installId: id, platform: 'android', channel: 'dev', appVersion: '1.2.0', buildNumber: 10, devicePublicKeyB64, enrollToken: 'test-session' }),
    });
    if (!res.ok) throw new Error(`enroll failed: ${res.status}`);
    return { id, privateKey };
  }

  const bundleFiles: ArchiveFile[] = [
    { path: 'index.android.bundle', data: Buffer.from('var x = 42; // OTA bundle for R2', 'utf8') },
    { path: 'assets/logo.txt', data: Buffer.from('LOGO-BYTES', 'utf8') },
  ];

  console.log('dash-ota backend e2e\n');

  await check('admin registers the trusted public key', async () => {
    const res = await adminPost('/admin/keys', { keyId, publicKeyRawB64: keys.publicKeyRawB64 });
    assert.equal(res.status, 200);
  });

  await check('CLI publishes a pre-signed release for runtimeVersion R2', async () => {
    const built = buildRelease({
      bundleId: 'bnd_R2_v1',
      runtimeVersion: 'R2',
      bundleVersion: 1,
      platform: 'android',
      channel: 'dev',
      mandatory: false,
      files: bundleFiles,
      keyId,
      releaseNotes: 'First OTA on R2',
    });
    const signed = signManifest(built.manifest, keys.privateKeyPem);
    const res = await adminPost('/admin/publish', {
      signedManifest: signed,
      ciphertextB64: built.ciphertext.toString('base64'),
      rolloutPercentage: 100,
    });
    assert.equal(res.status, 200, await res.text());
  });

  await check('publish rejects a tampered (post-sign) manifest', async () => {
    const built = buildRelease({
      bundleId: 'bnd_tampered',
      runtimeVersion: 'R2',
      bundleVersion: 2,
      platform: 'android',
      channel: 'dev',
      mandatory: false,
      files: bundleFiles,
      keyId,
    });
    const signed = signManifest(built.manifest, keys.privateKeyPem);
    const tampered = { ...signed, manifest: { ...signed.manifest, bundleVersion: 999 } };
    const res = await adminPost('/admin/publish', {
      signedManifest: tampered,
      ciphertextB64: built.ciphertext.toString('base64'),
      rolloutPercentage: 100,
    });
    assert.equal(res.status, 400);
  });

  const r2Device = await enroll('install-R2', 'R2');
  let serverNonce = '';

  await check('R2 device: check returns the update + download token + server nonce', async () => {
    const res = await signedPost(
      '/ota/v1/check',
      { installId: r2Device.id, platform: 'android', channel: 'dev', runtimeVersion: 'R2', appVersion: '1.2.0', buildNumber: 10, currentBundleVersion: 0 },
      r2Device,
    );
    assert.equal(res.status, 200);
    const data = (await res.json()) as CheckResponse;
    assert.ok(data.update, 'expected an update');
    assert.ok(data.downloadToken, 'expected a download token');
    assert.equal(data.update?.manifest.bundleId, 'bnd_R2_v1');
    serverNonce = data.serverNonce;

    // download + open exactly as native will
    const dl = await fetch(`${base}/ota/v1/download`, { headers: { [OTA_HEADERS.downloadToken]: data.downloadToken ?? '' } });
    assert.equal(dl.status, 200);
    const ciphertext = Buffer.from(await dl.arrayBuffer());
    const files = openRelease(data.update!, ciphertext, embeddedPublicKey);
    const bundle = files.find((f) => f.path === 'index.android.bundle');
    assert.match(bundle?.data.toString('utf8') ?? '', /OTA bundle for R2/);

    // the one-time token cannot be reused
    const reuse = await fetch(`${base}/ota/v1/download`, { headers: { [OTA_HEADERS.downloadToken]: data.downloadToken ?? '' } });
    assert.equal(reuse.status, 403);
  });

  await check('R1 device: NO update (runtimeVersion gate — the store-vs-OTA scenario)', async () => {
    const r1 = await enroll('install-R1', 'R1');
    const res = await signedPost(
      '/ota/v1/check',
      { installId: r1.id, platform: 'android', channel: 'dev', runtimeVersion: 'R1', appVersion: '1.2.0', buildNumber: 10, currentBundleVersion: 0 },
      r1,
    );
    const data = (await res.json()) as CheckResponse;
    assert.equal(data.update, null, 'R1 must not receive the R2 OTA');
  });

  await check('replayed request nonce is rejected', async () => {
    const body = { installId: r2Device.id, platform: 'android', channel: 'dev', runtimeVersion: 'R2', appVersion: '1.2.0', buildNumber: 10, currentBundleVersion: 0 };
    const raw = Buffer.from(JSON.stringify(body), 'utf8');
    const nonce = randomNonceB64();
    const timestamp = String(Date.now());
    const signature = deviceSign(r2Device.privateKey, requestSigningString({ method: 'POST', path: '/ota/v1/check', installId: r2Device.id, nonce, timestamp, bodySha256: sha256Hex(raw) }));
    const headers = {
      'content-type': 'application/json',
      [OTA_HEADERS.installId]: r2Device.id,
      [OTA_HEADERS.nonce]: nonce,
      [OTA_HEADERS.timestamp]: timestamp,
      [OTA_HEADERS.signature]: signature,
    };
    const first = await fetch(`${base}/ota/v1/check`, { method: 'POST', headers, body: raw });
    assert.equal(first.status, 200);
    const replay = await fetch(`${base}/ota/v1/check`, { method: 'POST', headers, body: raw });
    assert.equal(replay.status, 401);
  });

  await check('forged request signature is rejected', async () => {
    const body = { installId: r2Device.id, platform: 'android', channel: 'dev', runtimeVersion: 'R2', appVersion: '1.2.0', buildNumber: 10, currentBundleVersion: 0 };
    const raw = Buffer.from(JSON.stringify(body), 'utf8');
    const res = await fetch(`${base}/ota/v1/check`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [OTA_HEADERS.installId]: r2Device.id,
        [OTA_HEADERS.nonce]: randomNonceB64(),
        [OTA_HEADERS.timestamp]: String(Date.now()),
        [OTA_HEADERS.signature]: 'deadbeef',
      },
      body: raw,
    });
    assert.equal(res.status, 401);
  });

  await check('confirm healthy is recorded (bound to the server nonce)', async () => {
    const res = await signedPost('/ota/v1/confirm', { installId: r2Device.id, bundleId: 'bnd_R2_v1', runtimeVersion: 'R2', status: 'healthy', serverNonce }, r2Device);
    assert.equal(res.status, 200);
    const data = (await res.json()) as { ok: boolean; autoPaused: boolean };
    assert.equal(data.ok, true);
  });

  await check('force-update gate: hard severity when build is below minimum', async () => {
    await adminPost('/admin/native-policy', { channel: 'dev', minSupportedNativeVersion: 99, severity: 'hard', storeUrl: 'market://x' });
    const res = await signedPost(
      '/ota/v1/check',
      { installId: r2Device.id, platform: 'android', channel: 'dev', runtimeVersion: 'R2', appVersion: '1.2.0', buildNumber: 10, currentBundleVersion: 0 },
      r2Device,
    );
    const data = (await res.json()) as CheckResponse;
    assert.equal(data.nativePolicy.severity, 'hard');
    assert.equal(data.nativePolicy.storeUrl, 'market://x');
    // reset so it doesn't affect later checks
    await adminPost('/admin/native-policy', { channel: 'dev', minSupportedNativeVersion: 0, severity: 'soft' });
  });

  await check('rollout auto-pauses after repeated failures', async () => {
    // publish a fresh release to a dedicated install set
    const built = buildRelease({ bundleId: 'bnd_R2_bad', runtimeVersion: 'R2', bundleVersion: 5, platform: 'android', channel: 'dev', mandatory: false, files: bundleFiles, keyId });
    const signed = signManifest(built.manifest, keys.privateKeyPem);
    await adminPost('/admin/publish', { signedManifest: signed, ciphertextB64: built.ciphertext.toString('base64'), rolloutPercentage: 100 });

    let autoPaused = false;
    for (let i = 0; i < 2; i++) {
      const dev = await enroll(`install-bad-${i}`, 'R2');
      const checkRes = await signedPost(
        '/ota/v1/check',
        { installId: dev.id, platform: 'android', channel: 'dev', runtimeVersion: 'R2', appVersion: '1.2.0', buildNumber: 10, currentBundleVersion: 4 },
        dev,
      );
      const checkData = (await checkRes.json()) as CheckResponse;
      const confirmRes = await signedPost(
        '/ota/v1/confirm',
        { installId: dev.id, bundleId: 'bnd_R2_bad', runtimeVersion: 'R2', status: 'failed', serverNonce: checkData.serverNonce },
        dev,
      );
      const confirmData = (await confirmRes.json()) as { autoPaused: boolean };
      autoPaused = autoPaused || confirmData.autoPaused;
    }
    assert.equal(autoPaused, true, 'expected the rollout to auto-pause after failures');

    const list = await fetch(`${base}/admin/releases`, { headers: { 'x-ota-admin-token': ADMIN } });
    const releases = (await list.json()) as { releases: { bundleId: string; paused: boolean }[] };
    assert.equal(releases.releases.find((r) => r.bundleId === 'bnd_R2_bad')?.paused, true);
  });

  server.close();
  console.log(`\n${passed} e2e checks passed.`);
}

void main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
