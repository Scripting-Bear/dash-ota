/**
 * End-to-end test against the real HTTP server: publish → check → download → verify+decrypt,
 * plus the attack/edge cases that matter (runtimeVersion gate, replay, one-time token, bad
 * signature, auto-pause). Run: `npm run test:e2e`.
 *
 * @module e2e.test
 */

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type ArchiveFile,
  buildReleaseV2,
  type CheckResponse,
  generateSigningKeyPair,
  type SignedManifest,
  verifyReleaseV2,
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
    maxBundleBytes: 2048, // small cap so the size-guard test can trip with a modest bundle
    // low limits so the rate-limit tests trip deterministically; per-install isolation keeps the
    // other checks (≤ 3 requests per install) well under these.
    enrollRateLimit: 5,
    checkRateLimit: 5,
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

  async function adminGet(path: string): Promise<Response> {
    return fetch(`${base}${path}`, { headers: { 'x-ota-admin-token': ADMIN } });
  }

  async function enroll(id: string, runtimeVersion: string): Promise<Install> {
    void runtimeVersion;
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const devicePublicKeyB64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    const res = await fetch(`${base}/ota/v2/enroll`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        installId: id,
        platform: 'android',
        channel: 'dev',
        appVersion: '1.2.0',
        buildNumber: 10,
        devicePublicKeyB64,
        enrollToken: 'test-session',
      }),
    });
    if (!res.ok) throw new Error(`enroll failed: ${res.status}`);
    return { id, privateKey };
  }

  const bundleFiles: ArchiveFile[] = [
    { path: 'index.android.bundle', data: Buffer.from('var x = 42; // OTA bundle for R2', 'utf8') },
    { path: 'assets/logo.txt', data: Buffer.from('LOGO-BYTES', 'utf8') },
  ];

  console.log('dash-ota backend e2e\n');

  await check('health is liveness-only; ready reflects the store', async () => {
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true });
    const ready = await fetch(`${base}/ready`);
    assert.equal(ready.status, 200);
    const body = (await ready.json()) as { ready: boolean; releases: number };
    assert.equal(body.ready, true);
    assert.equal(typeof body.releases, 'number');
  });

  await check('admin registers the trusted public key', async () => {
    const res = await adminPost('/admin/keys', { keyId, publicKeyRawB64: keys.publicKeyRawB64 });
    assert.equal(res.status, 200);
  });

  /**
   * Publish exactly as the CLI will: manifest first, then every missing blob, then finalize.
   *
   * @returns the signed manifest, the blobs, and the response of each step.
   */
  async function publishRelease(
    input: Parameters<typeof buildReleaseV2>[0],
    opts: { rollout?: number; tamper?: (m: SignedManifest) => SignedManifest; skipFinalize?: boolean } = {},
  ) {
    const built = await buildReleaseV2(input);
    const signed = opts.tamper
      ? opts.tamper(signManifest(built.manifest, keys.privateKeyPem))
      : signManifest(built.manifest, keys.privateKeyPem);
    const created = await adminPost('/admin/releases', { signedManifest: signed, rolloutPercentage: opts.rollout ?? 100 });
    if (created.status !== 200) return { built, signed, created, uploads: [], finalized: null };

    const { missing } = (await created.clone().json()) as { missing: string[] };
    const uploads: Response[] = [];
    for (const sha of missing) {
      const bytes = built.blobs.get(sha);
      assert.ok(bytes, `missing local blob ${sha}`);
      uploads.push(
        await fetch(`${base}/admin/releases/${signed.manifest.bundleId}/blobs/${sha}`, {
          method: 'PUT',
          headers: { 'x-ota-admin-token': ADMIN, 'content-type': 'application/octet-stream' },
          body: new Uint8Array(bytes),
        }),
      );
    }
    const finalized = opts.skipFinalize ? null : await adminPost(`/admin/releases/${signed.manifest.bundleId}/finalize`, {});
    return { built, signed, created, uploads, finalized };
  }

  await check('CLI publishes a pre-signed release for runtimeVersion R2 in three steps', async () => {
    const { created, uploads, finalized } = await publishRelease({
      bundleId: 'bnd_R2_v1',
      runtimeVersion: 'R2',
      bundleVersion: 1,
      platform: 'android',
      channel: 'dev',
      appId: 'com.example.app',
      mandatory: false,
      files: bundleFiles,
      bundlePath: 'index.android.bundle',
      keyId,
      releaseNotes: 'First OTA on R2',
    });
    assert.equal(created.status, 200, await created.text());
    for (const u of uploads) assert.equal(u.status, 200, await u.text());
    assert.equal(finalized?.status, 200, await finalized?.text());
  });

  await check('a published release is immutable — the same bundleId cannot be replaced', async () => {
    const { created } = await publishRelease({
      bundleId: 'bnd_R2_v1',
      runtimeVersion: 'R2',
      bundleVersion: 1,
      platform: 'android',
      channel: 'dev',
      appId: 'com.example.app',
      mandatory: false,
      files: bundleFiles,
      bundlePath: 'index.android.bundle',
      keyId,
      releaseNotes: 'First OTA on R2',
    });
    // Devices may already be running it, and its manifest is signed: silently swapping the content
    // behind a bundleId is exactly the ambiguity signing exists to prevent.
    const body = (await created.json()) as { code: string };
    assert.equal(created.status, 409, JSON.stringify(body));
    assert.equal(body.code, 'already_published');
  });

  await check('a release is invisible to devices until it is finalized', async () => {
    const { created } = await publishRelease(
      {
        bundleId: 'bnd_unfinalized',
        runtimeVersion: 'R2',
        bundleVersion: 90,
        platform: 'android',
        channel: 'dev',
        appId: 'com.example.app',
        mandatory: false,
        files: bundleFiles,
        bundlePath: 'index.android.bundle',
        keyId,
      },
      { skipFinalize: true },
    );
    assert.equal(created.status, 200);
    const listed = (await (await adminGet('/admin/releases')).json()) as { releases: { bundleId: string; finalized: boolean }[] };
    assert.equal(listed.releases.find((r) => r.bundleId === 'bnd_unfinalized')?.finalized, false);
  });

  await check('finalize refuses while blobs are still missing', async () => {
    const built = await buildReleaseV2({
      bundleId: 'bnd_incomplete',
      runtimeVersion: 'R2',
      bundleVersion: 91,
      platform: 'android',
      channel: 'dev',
      appId: 'com.example.app',
      mandatory: false,
      files: bundleFiles,
      bundlePath: 'index.android.bundle',
      keyId,
    });
    const signed = signManifest(built.manifest, keys.privateKeyPem);
    await adminPost('/admin/releases', { signedManifest: signed, rolloutPercentage: 100 });
    const res = await adminPost('/admin/releases/bnd_incomplete/finalize', {});
    const body = (await res.json()) as { code: string; missing: string[] };
    assert.equal(res.status, 409);
    assert.equal(body.code, 'incomplete');
    assert.ok(body.missing.length > 0);
  });

  await check('a blob whose bytes do not match its hash is refused', async () => {
    const built = await buildReleaseV2({
      bundleId: 'bnd_badblob',
      runtimeVersion: 'R2',
      bundleVersion: 92,
      platform: 'android',
      channel: 'dev',
      appId: 'com.example.app',
      mandatory: false,
      files: bundleFiles,
      bundlePath: 'index.android.bundle',
      keyId,
    });
    const signed = signManifest(built.manifest, keys.privateKeyPem);
    const created = await adminPost('/admin/releases', { signedManifest: signed, rolloutPercentage: 100 });
    const { missing } = (await created.json()) as { missing: string[] };
    const sha = missing[0] as string;
    const res = await fetch(`${base}/admin/releases/bnd_badblob/blobs/${sha}`, {
      method: 'PUT',
      headers: { 'x-ota-admin-token': ADMIN, 'content-type': 'application/octet-stream' },
      body: new Uint8Array(Buffer.from('not the signed bytes')),
    });
    const body = (await res.json()) as { code: string };
    assert.equal(res.status, 400);
    assert.ok(body.code === 'hash_mismatch' || body.code === 'size_mismatch', body.code);
  });

  await check('publish rejects a tampered (post-sign) manifest', async () => {
    const { created } = await publishRelease(
      {
        bundleId: 'bnd_tampered',
        runtimeVersion: 'R2',
        bundleVersion: 2,
        platform: 'android',
        channel: 'dev',
        appId: 'com.example.app',
        mandatory: false,
        files: bundleFiles,
        bundlePath: 'index.android.bundle',
        keyId,
      },
      { tamper: (m) => ({ ...m, manifest: { ...m.manifest, bundleVersion: 999 } }) },
    );
    assert.equal(created.status, 400);
  });

  await check('publish rejects an oversized release (size cap)', async () => {
    const { created } = await publishRelease({
      bundleId: 'bnd_R2_huge',
      runtimeVersion: 'R2',
      bundleVersion: 3,
      platform: 'android',
      channel: 'dev',
      appId: 'com.example.app',
      mandatory: false,
      // Random bytes so compression cannot shrink it back under the cap.
      files: [{ path: 'index.android.bundle', data: randomBytes(4096) }],
      bundlePath: 'index.android.bundle',
      keyId,
    });
    const body = (await created.json()) as { code: string };
    assert.equal(created.status, 413, JSON.stringify(body));
    assert.equal(body.code, 'too_large');
  });

  const r2Device = await enroll('install-R2', 'R2');
  let serverNonce = '';

  await check('R2 device: check returns the update + download token + server nonce', async () => {
    const res = await signedPost(
      '/ota/v2/check',
      {
        installId: r2Device.id,
        platform: 'android',
        channel: 'dev',
        runtimeVersion: 'R2',
        appVersion: '1.2.0',
        buildNumber: 10,
        currentBundleVersion: 0,
      },
      r2Device,
    );
    assert.equal(res.status, 200);
    const data = (await res.json()) as CheckResponse;
    assert.ok(data.update, 'expected an update');
    assert.ok(data.downloadToken, 'expected a download token');
    assert.equal(data.update?.manifest.bundleId, 'bnd_R2_v1');
    serverNonce = data.serverNonce;

    // Fetch and reassemble exactly as native will: one blob at a time, verified against the
    // signed manifest.
    const token = data.downloadToken ?? '';
    const blobUrl = (sha: string): string => `${base}/ota/v2/releases/bnd_R2_v1/blobs/${sha}`;
    const fetchBlob = async (sha: string): Promise<Buffer> => {
      const res2 = await fetch(blobUrl(sha), { headers: { [OTA_HEADERS.downloadToken]: token } });
      assert.equal(res2.status, 200);
      assert.equal(res2.headers.get('etag'), `"${sha}"`);
      const bytes = Buffer.from(await res2.arrayBuffer());
      assert.equal(Number(res2.headers.get('content-length')), bytes.byteLength);
      return bytes;
    };
    const opened = await verifyReleaseV2(data.update!, fetchBlob, embeddedPublicKey);
    const bundle = opened.files.find((f) => f.path === 'index.android.bundle');
    assert.match(bundle?.data.toString('utf8') ?? '', /OTA bundle for R2/);

    // The token is reusable within its TTL — one update is many requests, and a resumed one more.
    const anySha = data.update!.manifest.files[0]!.blob.sha256;
    assert.equal((await fetch(blobUrl(anySha), { headers: { [OTA_HEADERS.downloadToken]: token } })).status, 200);
  });

  await check('a blob can be resumed with a byte range', async () => {
    // Its own install: `checkRateLimit` is per-install and r2Device is close to its budget.
    const dev = await enroll('install-range', 'R2');
    const res = await signedPost(
      '/ota/v2/check',
      {
        installId: dev.id,
        platform: 'android',
        channel: 'dev',
        runtimeVersion: 'R2',
        appVersion: '1.2.0',
        buildNumber: 10,
        currentBundleVersion: 0,
      },
      dev,
    );
    const data = (await res.json()) as CheckResponse;
    const entry = data.update!.manifest.files[0]!;
    const url = `${base}/ota/v2/releases/bnd_R2_v1/blobs/${entry.blob.sha256}`;
    const headers = { [OTA_HEADERS.downloadToken]: data.downloadToken ?? '' };

    const whole = Buffer.from(await (await fetch(url, { headers })).arrayBuffer());
    const half = Math.floor(whole.byteLength / 2);

    const tail = await fetch(url, { headers: { ...headers, range: `bytes=${half}-` } });
    assert.equal(tail.status, 206);
    assert.equal(tail.headers.get('content-range'), `bytes ${half}-${whole.byteLength - 1}/${whole.byteLength}`);
    const tailBytes = Buffer.from(await tail.arrayBuffer());
    // Resuming from the halfway point must reproduce the blob exactly.
    assert.deepEqual(Buffer.concat([whole.subarray(0, half), tailBytes]), whole);

    const past = await fetch(url, { headers: { ...headers, range: `bytes=${whole.byteLength + 10}-` } });
    assert.equal(past.status, 416);
    assert.equal(past.headers.get('content-range'), `bytes */${whole.byteLength}`);
  });

  await check('a download token is scoped to its own release', async () => {
    const dev = await enroll('install-scope', 'R2');
    const res = await signedPost(
      '/ota/v2/check',
      {
        installId: dev.id,
        platform: 'android',
        channel: 'dev',
        runtimeVersion: 'R2',
        appVersion: '1.2.0',
        buildNumber: 10,
        currentBundleVersion: 0,
      },
      dev,
    );
    const data = (await res.json()) as CheckResponse;
    const sha = data.update!.manifest.files[0]!.blob.sha256;
    const wrong = await fetch(`${base}/ota/v2/releases/bnd_other/blobs/${sha}`, {
      headers: { [OTA_HEADERS.downloadToken]: data.downloadToken ?? '' },
    });
    assert.equal(wrong.status, 403);
    const noToken = await fetch(`${base}/ota/v2/releases/bnd_R2_v1/blobs/${sha}`);
    assert.equal(noToken.status, 403);
  });

  await check('a retired v1 client is told to update from the store, and is counted', async () => {
    const res = await fetch(`${base}/ota/v1/check`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channel: 'dev', platform: 'android', runtimeVersion: 'R2' }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { update: null; nativePolicy: { severity: string } };
    assert.equal(body.update, null);
    assert.equal(body.nativePolicy.severity, 'hard');

    assert.equal((await fetch(`${base}/ota/v1/download`)).status, 410);

    const listed = (await (await adminGet('/admin/releases')).json()) as { retiredClients: Record<string, number> };
    assert.ok((listed.retiredClients['dev/android'] ?? 0) >= 1, 'retired hit should be counted');
  });

  await check('R1 device: NO update (runtimeVersion gate — the store-vs-OTA scenario)', async () => {
    const r1 = await enroll('install-R1', 'R1');
    const res = await signedPost(
      '/ota/v2/check',
      {
        installId: r1.id,
        platform: 'android',
        channel: 'dev',
        runtimeVersion: 'R1',
        appVersion: '1.2.0',
        buildNumber: 10,
        currentBundleVersion: 0,
      },
      r1,
    );
    const data = (await res.json()) as CheckResponse;
    assert.equal(data.update, null, 'R1 must not receive the R2 OTA');
  });

  await check('replayed request nonce is rejected', async () => {
    const body = {
      installId: r2Device.id,
      platform: 'android',
      channel: 'dev',
      runtimeVersion: 'R2',
      appVersion: '1.2.0',
      buildNumber: 10,
      currentBundleVersion: 0,
    };
    const raw = Buffer.from(JSON.stringify(body), 'utf8');
    const nonce = randomNonceB64();
    const timestamp = String(Date.now());
    const signature = deviceSign(
      r2Device.privateKey,
      requestSigningString({
        method: 'POST',
        path: '/ota/v2/check',
        installId: r2Device.id,
        nonce,
        timestamp,
        bodySha256: sha256Hex(raw),
      }),
    );
    const headers = {
      'content-type': 'application/json',
      [OTA_HEADERS.installId]: r2Device.id,
      [OTA_HEADERS.nonce]: nonce,
      [OTA_HEADERS.timestamp]: timestamp,
      [OTA_HEADERS.signature]: signature,
    };
    const first = await fetch(`${base}/ota/v2/check`, { method: 'POST', headers, body: raw });
    assert.equal(first.status, 200);
    const replay = await fetch(`${base}/ota/v2/check`, { method: 'POST', headers, body: raw });
    assert.equal(replay.status, 401);
  });

  await check('forged request signature is rejected', async () => {
    const body = {
      installId: r2Device.id,
      platform: 'android',
      channel: 'dev',
      runtimeVersion: 'R2',
      appVersion: '1.2.0',
      buildNumber: 10,
      currentBundleVersion: 0,
    };
    const raw = Buffer.from(JSON.stringify(body), 'utf8');
    const res = await fetch(`${base}/ota/v2/check`, {
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

  await check('a stale timestamp is rejected (skew window)', async () => {
    const body = {
      installId: r2Device.id,
      platform: 'android',
      channel: 'dev',
      runtimeVersion: 'R2',
      appVersion: '1.2.0',
      buildNumber: 10,
      currentBundleVersion: 0,
    };
    const raw = Buffer.from(JSON.stringify(body), 'utf8');
    const nonce = randomNonceB64();
    const staleTs = String(Date.now() - 10 * 60 * 1000); // 10 min old, beyond the 5 min default skew
    const signature = deviceSign(
      r2Device.privateKey,
      requestSigningString({
        method: 'POST',
        path: '/ota/v2/check',
        installId: r2Device.id,
        nonce,
        timestamp: staleTs,
        bodySha256: sha256Hex(raw),
      }),
    );
    const res = await fetch(`${base}/ota/v2/check`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [OTA_HEADERS.installId]: r2Device.id,
        [OTA_HEADERS.nonce]: nonce,
        [OTA_HEADERS.timestamp]: staleTs,
        [OTA_HEADERS.signature]: signature,
      },
      body: raw,
    });
    assert.equal(res.status, 401);
    assert.equal(((await res.json()) as { code: string }).code, 'stale_timestamp');
  });

  await check('a hostile devicePublicKeyB64 fails closed (401, not a 500 crash)', async () => {
    // Enroll an install with a garbage public key, then sign a request — the malformed key must
    // make verification fail closed, not throw a 500.
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const enrollRes = await fetch(`${base}/ota/v2/enroll`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        installId: 'install-hostile-key',
        platform: 'android',
        channel: 'dev',
        devicePublicKeyB64: Buffer.from('not-a-real-spki-der-key').toString('base64'),
        enrollToken: 'test-session',
      }),
    });
    assert.equal(enrollRes.status, 200);
    const hostile: Install = { id: 'install-hostile-key', privateKey };
    const res = await signedPost(
      '/ota/v2/check',
      {
        installId: hostile.id,
        platform: 'android',
        channel: 'dev',
        runtimeVersion: 'R2',
        appVersion: '1.2.0',
        buildNumber: 10,
        currentBundleVersion: 0,
      },
      hostile,
    );
    assert.equal(res.status, 401);
  });

  await check('confirm healthy is recorded (bound to the server nonce)', async () => {
    const res = await signedPost(
      '/ota/v2/confirm',
      { installId: r2Device.id, bundleId: 'bnd_R2_v1', runtimeVersion: 'R2', status: 'healthy', serverNonce },
      r2Device,
    );
    assert.equal(res.status, 200);
    const data = (await res.json()) as { ok: boolean; autoPaused: boolean };
    assert.equal(data.ok, true);
  });

  await check('confirm for a bundle the server nonce was NOT issued for is rejected', async () => {
    // Fresh check → a server nonce bound to bnd_R2_v1; confirming a different bundleId must fail.
    const checkRes = await signedPost(
      '/ota/v2/check',
      {
        installId: r2Device.id,
        platform: 'android',
        channel: 'dev',
        runtimeVersion: 'R2',
        appVersion: '1.2.0',
        buildNumber: 10,
        currentBundleVersion: 0,
      },
      r2Device,
    );
    const nonce = ((await checkRes.json()) as CheckResponse).serverNonce;
    const res = await signedPost(
      '/ota/v2/confirm',
      { installId: r2Device.id, bundleId: 'bnd_not_offered', runtimeVersion: 'R2', status: 'failed', serverNonce: nonce },
      r2Device,
    );
    assert.equal(res.status, 401);
    assert.equal(((await res.json()) as { code: string }).code, 'bad_nonce');
  });

  // These two use their own installs: `checkRateLimit` is per-install, and r2Device is already
  // close to its budget above — borrowing it would fail the *next* test, not this one.
  const healthyDevice = await enroll('install-healthy-uptodate', 'R2');

  await check('healthy confirm works off an up-to-date check (install-only nonce)', async () => {
    // The real `healthy` sequence: a device already running the newest bundle checks, is told there
    // is nothing new (so the nonce carries no bundle binding), then confirms the bundle it is
    // running. Requiring an exact bundle match here rejected every healthy report, pinning the
    // adoption counter at 0 — the up-to-date nonce must act as an install-scoped wildcard.
    const checkRes = await signedPost(
      '/ota/v2/check',
      {
        installId: healthyDevice.id,
        platform: 'android',
        channel: 'dev',
        runtimeVersion: 'R2',
        appVersion: '1.2.0',
        buildNumber: 10,
        currentBundleVersion: 999, // newer than anything published → no update offered
      },
      healthyDevice,
    );
    const data = (await checkRes.json()) as CheckResponse;
    assert.equal(data.update, null, 'expected an up-to-date check');
    const res = await signedPost(
      '/ota/v2/confirm',
      {
        installId: healthyDevice.id,
        bundleId: 'bnd_R2_v1',
        runtimeVersion: 'R2',
        status: 'healthy',
        serverNonce: data.serverNonce,
      },
      healthyDevice,
    );
    const body = (await res.json()) as { ok?: boolean; code?: string };
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.ok, true);
  });

  await check('an install-only nonce is still scoped to its own install', async () => {
    const victim = await enroll('install-nonce-victim', 'R2');
    const attacker = await enroll('install-nonce-attacker', 'R2');
    const checkRes = await signedPost(
      '/ota/v2/check',
      {
        installId: victim.id,
        platform: 'android',
        channel: 'dev',
        runtimeVersion: 'R2',
        appVersion: '1.2.0',
        buildNumber: 10,
        currentBundleVersion: 999,
      },
      victim,
    );
    const nonce = ((await checkRes.json()) as CheckResponse).serverNonce;
    // Another enrolled device replaying the victim's nonce must still be rejected.
    const res = await signedPost(
      '/ota/v2/confirm',
      { installId: attacker.id, bundleId: 'bnd_R2_v1', runtimeVersion: 'R2', status: 'healthy', serverNonce: nonce },
      attacker,
    );
    assert.equal(res.status, 401);
    assert.equal(((await res.json()) as { code: string }).code, 'bad_nonce');
  });

  await check('force-update gate: hard severity when build is below minimum', async () => {
    await adminPost('/admin/native-policy', {
      channel: 'dev',
      minSupportedNativeVersion: 99,
      severity: 'hard',
      storeUrl: 'market://x',
    });
    const res = await signedPost(
      '/ota/v2/check',
      {
        installId: r2Device.id,
        platform: 'android',
        channel: 'dev',
        runtimeVersion: 'R2',
        appVersion: '1.2.0',
        buildNumber: 10,
        currentBundleVersion: 0,
      },
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
    await publishRelease({
      bundleId: 'bnd_R2_bad',
      runtimeVersion: 'R2',
      bundleVersion: 5,
      platform: 'android',
      channel: 'dev',
      appId: 'com.example.app',
      mandatory: false,
      files: bundleFiles,
      bundlePath: 'index.android.bundle',
      keyId,
    });

    let autoPaused = false;
    for (let i = 0; i < 2; i++) {
      const dev = await enroll(`install-bad-${i}`, 'R2');
      const checkRes = await signedPost(
        '/ota/v2/check',
        {
          installId: dev.id,
          platform: 'android',
          channel: 'dev',
          runtimeVersion: 'R2',
          appVersion: '1.2.0',
          buildNumber: 10,
          currentBundleVersion: 4,
        },
        dev,
      );
      const checkData = (await checkRes.json()) as CheckResponse;
      const confirmRes = await signedPost(
        '/ota/v2/confirm',
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

  await check('admin rejects a wrong token (403, constant-time compare)', async () => {
    const res = await fetch(`${base}/admin/releases`, { headers: { 'x-ota-admin-token': 'not-the-admin-token' } });
    assert.equal(res.status, 403);
  });

  await check('enroll is rate-limited per install (429 + Retry-After)', async () => {
    const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const devicePublicKeyB64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    const enrollOnce = (): Promise<Response> =>
      fetch(`${base}/ota/v2/enroll`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          installId: 'install-rl-enroll',
          platform: 'android',
          channel: 'dev',
          devicePublicKeyB64,
          enrollToken: 'test-session',
        }),
      });
    for (let i = 0; i < 5; i++) assert.equal((await enrollOnce()).status, 200);
    const limited = await enrollOnce();
    const body = (await limited.json()) as { code: string };
    assert.equal(limited.status, 429, JSON.stringify(body));
    assert.equal(body.code, 'rate_limited');
    assert.ok(limited.headers.get('retry-after'), 'expected a Retry-After header');
  });

  await check('check is rate-limited per authenticated install (429)', async () => {
    const dev = await enroll('install-rl-check', 'R2');
    const doCheck = (): Promise<Response> =>
      signedPost(
        '/ota/v2/check',
        {
          installId: dev.id,
          platform: 'android',
          channel: 'dev',
          runtimeVersion: 'R2',
          appVersion: '1.2.0',
          buildNumber: 10,
          currentBundleVersion: 0,
        },
        dev,
      );
    for (let i = 0; i < 5; i++) assert.equal((await doCheck()).status, 200);
    const limited = await doCheck();
    const body = (await limited.json()) as { code: string };
    assert.equal(limited.status, 429, JSON.stringify(body));
    assert.equal(body.code, 'rate_limited');
  });

  server.close();
  console.log(`\n${passed} e2e checks passed.`);
}

void main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
