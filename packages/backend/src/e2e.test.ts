/**
 * End-to-end test against the real HTTP server: publish → check → download → verify+decrypt,
 * plus the attack/edge cases that matter (runtimeVersion gate, replay, one-time token, bad
 * signature, auto-pause). Run: `npm run test:e2e`.
 *
 * @module e2e.test
 */

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { request, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
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
import { type BackendConfig, loadConfig, resolveBackendConfig } from './config.js';
import { createRouter, isEntryPoint } from './server.js';
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
  const config: BackendConfig = {
    ...loadConfig(),
    port: 0,
    adminToken: ADMIN,
    storageDir: join(tmp, 'storage'),
    dataDir: join(tmp, 'data'),
    autoPauseMinSamples: 2,
    autoPauseFailureRate: 0.2,
    requireRequestSignature: true,
    maxBundleBytes: 2048, // small cap so the size-guard test can trip with a modest bundle
    maxBlobBytes: 8192,
    maxAdminBodyBytes: 512 * 1024,
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

  /** A `/check` body for an R2 android/dev device, as the RN client sends it. */
  const checkBody = (install: Install, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    installId: install.id,
    platform: 'android',
    channel: 'dev',
    runtimeVersion: 'R2',
    appVersion: '1.2.0',
    buildNumber: 10,
    currentBundleVersion: 0,
    currentBundleId: '',
    ...extra,
  });

  /** Check, then confirm with the nonce that check returned. */
  async function checkThenConfirm(
    install: Install,
    confirm: { bundleId: string; status: string },
    checkExtra: Record<string, unknown> = {},
  ): Promise<{ check: CheckResponse; res: Response }> {
    const check = (await (await signedPost('/ota/v2/check', checkBody(install, checkExtra), install)).json()) as CheckResponse;
    const res = await signedPost(
      '/ota/v2/confirm',
      { installId: install.id, runtimeVersion: 'R2', serverNonce: check.serverNonce, ...confirm },
      install,
    );
    return { check, res };
  }

  const bundleFiles: ArchiveFile[] = [
    { path: 'index.android.bundle', data: Buffer.from('var x = 42; // OTA bundle for R2', 'utf8') },
    { path: 'assets/logo.txt', data: Buffer.from('LOGO-BYTES', 'utf8') },
  ];

  /**
   * Fixture files whose bytes appear in no other release.
   *
   * The blob store is global and content-addressed, so a test that needs a blob to be *missing*
   * cannot reuse {@link bundleFiles} — an earlier release already uploaded those exact bytes and
   * the store would correctly report nothing missing.
   *
   * @param tag - something unique to this test.
   * @returns a one-file bundle nobody else has published.
   */
  const uniqueFiles = (tag: string): ArchiveFile[] => [
    { path: 'index.android.bundle', data: Buffer.from(`var x = 42; // ${tag}`, 'utf8') },
    { path: 'assets/logo.txt', data: Buffer.from(`LOGO-BYTES-${tag}`, 'utf8') },
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

  /** Fixed content key for the fixtures. Real channels hold one of these; tests must not randomise it. */
  const TEST_CONTENT_KEY = Buffer.alloc(32, 7);

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
    const built = await buildReleaseV2({ contentKey: TEST_CONTENT_KEY, ...input });
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

  /**
   * Upload one blob.
   *
   * @param path - the admin blob path.
   * @param bytes - the blob body.
   * @returns the response.
   */
  const adminPut = (path: string, bytes: Buffer): Promise<Response> =>
    fetch(`${base}${path}`, {
      method: 'PUT',
      headers: { 'x-ota-admin-token': ADMIN, 'content-type': 'application/octet-stream' },
      body: new Uint8Array(bytes),
    });

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
      files: uniqueFiles('incomplete'),
      contentKey: TEST_CONTENT_KEY,
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

  await check('re-declaring an interrupted publish keeps the blobs already uploaded', async () => {
    const files = uniqueFiles('resume');
    const build = async () =>
      buildReleaseV2({
        bundleId: 'bnd_resume',
        runtimeVersion: 'R_HOUSEKEEPING',
        bundleVersion: 93,
        platform: 'android',
        channel: 'dev',
        appId: 'com.example.app',
        mandatory: false,
        files,
        bundlePath: 'index.android.bundle',
        keyId,
        contentKey: TEST_CONTENT_KEY,
      });

    // First attempt: declare, upload one blob, then "crash" before finalize.
    const first = await build();
    const signedFirst = signManifest(first.manifest, keys.privateKeyPem);
    const declared = (await (
      await adminPost('/admin/releases', { signedManifest: signedFirst, rolloutPercentage: 100 })
    ).json()) as { missing: string[] };
    assert.equal(declared.missing.length, 2);
    const uploaded = declared.missing[0] as string;
    await adminPut(`/admin/releases/bnd_resume/blobs/${uploaded}`, first.blobs.get(uploaded) as Buffer);

    // Re-running the same publish must not throw away what already landed.
    const again = await build();
    assert.equal(
      signManifest(again.manifest, keys.privateKeyPem).manifest.files[0]?.blob.sha256,
      signedFirst.manifest.files[0]?.blob.sha256,
    );
    const redeclared = (await (
      await adminPost('/admin/releases', {
        signedManifest: signManifest(again.manifest, keys.privateKeyPem),
        rolloutPercentage: 100,
      })
    ).json()) as { missing: string[] };
    assert.equal(redeclared.missing.length, 1, 'the already-uploaded blob was discarded — resume is broken');
    assert.ok(!redeclared.missing.includes(uploaded));
  });

  await check('replacing a release keeps blobs another release still uses', async () => {
    // bnd_share_a is finalized and shares both blobs with the unfinalised bnd_share_b.
    const shared = uniqueFiles('shared');
    const mk = async (bundleId: string, bundleVersion: number, fs = shared) =>
      buildReleaseV2({
        bundleId,
        runtimeVersion: 'R_HOUSEKEEPING',
        bundleVersion,
        platform: 'android',
        channel: 'dev',
        appId: 'com.example.app',
        mandatory: false,
        files: fs,
        bundlePath: 'index.android.bundle',
        keyId,
        contentKey: TEST_CONTENT_KEY,
      });

    const a = await mk('bnd_share_a', 94);
    const signedA = signManifest(a.manifest, keys.privateKeyPem);
    const missingA = (await (await adminPost('/admin/releases', { signedManifest: signedA, rolloutPercentage: 100 })).json()) as {
      missing: string[];
    };
    for (const sha of missingA.missing) await adminPut(`/admin/releases/bnd_share_a/blobs/${sha}`, a.blobs.get(sha) as Buffer);
    assert.equal((await adminPost('/admin/releases/bnd_share_a/finalize', {})).status, 200);

    const b = await mk('bnd_share_b', 95);
    await adminPost('/admin/releases', { signedManifest: signManifest(b.manifest, keys.privateKeyPem), rolloutPercentage: 100 });

    // Now replace bnd_share_b with a release that has completely different content. Its old blobs
    // are still bnd_share_a's, and must survive.
    const b2 = await mk('bnd_share_b', 96, uniqueFiles('shared-v2'));
    await adminPost('/admin/releases', { signedManifest: signManifest(b2.manifest, keys.privateKeyPem), rolloutPercentage: 100 });

    const stillMissing = (await (await adminPost('/admin/releases/bnd_share_a/finalize', {})).json()) as {
      ok?: boolean;
      missing?: string[];
    };
    assert.ok(stillMissing.ok, `bnd_share_a lost blobs when bnd_share_b was replaced: ${JSON.stringify(stillMissing.missing)}`);
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
      files: uniqueFiles('badblob'),
      contentKey: TEST_CONTENT_KEY,
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

  await check('healthy confirm works off an up-to-date check that reports the running bundle', async () => {
    // The real `healthy` sequence: a device already running the newest bundle checks, is told there
    // is nothing new, then confirms the bundle it reported running on that check.
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
        currentBundleId: 'bnd_R2_v1',
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

  await check('an up-to-date nonce is still scoped to its own install', async () => {
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
        currentBundleId: 'bnd_R2_v1',
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

  await check('an up-to-date nonce does not cover a bundle the check did not name', async () => {
    // The QA attack: a "no update" nonce used to confirm any bundle, so any device could auto-pause any release.
    const dev = await enroll('install-nonce-unnamed', 'R2');
    const { check: data, res } = await checkThenConfirm(
      dev,
      { bundleId: 'bnd_R2_v1', status: 'failed' },
      { currentBundleVersion: 999 },
    );
    assert.equal(data.update, null);
    assert.equal(res.status, 401);
    assert.equal(((await res.json()) as { code: string }).code, 'bad_nonce');
  });

  await check('a nonce never covers a release on another platform or channel', async () => {
    const { finalized } = await publishRelease({
      bundleId: 'bnd_ios_prod',
      runtimeVersion: 'R2',
      bundleVersion: 1,
      platform: 'ios',
      channel: 'prod',
      appId: 'com.example.app',
      mandatory: false,
      files: [{ path: 'main.jsbundle', data: Buffer.from('var ios = 1;', 'utf8') }],
      bundlePath: 'main.jsbundle',
      keyId,
    });
    assert.equal(finalized?.status, 200);
    const dev = await enroll('install-cross-scope', 'R2');
    // Naming it as the current bundle on an android/dev check still does not make it confirmable.
    for (const status of ['failed', 'healthy']) {
      const { res } = await checkThenConfirm(dev, { bundleId: 'bnd_ios_prod', status }, { currentBundleId: 'bnd_ios_prod' });
      assert.equal(res.status, 401, `${status} for an ios/prod release off an android/dev check`);
    }
    const listed = (await (await adminGet('/admin/releases')).json()) as {
      releases: { bundleId: string; adoption: Record<string, number> }[];
    };
    assert.equal(listed.releases.find((r) => r.bundleId === 'bnd_ios_prod')?.adoption.failed, 0);
  });

  await check('one nonce covers each (bundle, status) pair once: applied and healthy both count', async () => {
    // Clients send every report after a check with that check's one nonce: `applied`, then `healthy`.
    const adoption = async (): Promise<Record<string, number>> => {
      const listed = (await (await adminGet('/admin/releases')).json()) as {
        releases: { bundleId: string; adoption: Record<string, number> }[];
      };
      return listed.releases.find((r) => r.bundleId === 'bnd_R2_v1')?.adoption ?? {};
    };
    const before = await adoption();
    const dev = await enroll('install-nonce-pairs', 'R2');
    const data = (await (await signedPost('/ota/v2/check', checkBody(dev), dev)).json()) as CheckResponse;
    assert.equal(data.update?.manifest.bundleId, 'bnd_R2_v1');
    const confirm = (bundleId: string, status: string): Promise<Response> =>
      signedPost(
        '/ota/v2/confirm',
        { installId: dev.id, bundleId, runtimeVersion: 'R2', status, serverNonce: data.serverNonce },
        dev,
      );
    assert.equal((await confirm('bnd_ios_prod', 'applied')).status, 401, 'a bundle the check did not cover');
    assert.equal((await confirm('bnd_R2_v1', 'applied')).status, 200);
    assert.equal((await confirm('bnd_R2_v1', 'healthy')).status, 200, 'healthy after applied on the same nonce');
    assert.equal((await confirm('bnd_R2_v1', 'applied')).status, 401, 'a repeated (bundle, status) pair');
    const after = await adoption();
    assert.equal(after.applied, (before.applied ?? 0) + 1);
    assert.equal(after.healthy, (before.healthy ?? 0) + 1);
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

  await check('native-policy validates its input (the policy is not signed)', async () => {
    // storeUrl is rendered behind a blocking gate and is NOT covered by the manifest signature,
    // so the admin route must refuse anything that is not a store link.
    for (const storeUrl of ['javascript:alert(1)', 'http://evil.example', 'data:text/html,x', '//evil']) {
      const res = await adminPost('/admin/native-policy', {
        channel: 'dev',
        minSupportedNativeVersion: 1,
        severity: 'hard',
        storeUrl,
      });
      assert.equal(res.status, 400, `storeUrl ${storeUrl} must be refused`);
    }

    const badSeverity = await adminPost('/admin/native-policy', {
      channel: 'dev',
      minSupportedNativeVersion: 1,
      severity: 'blocking',
    });
    assert.equal(badSeverity.status, 400);

    const badMin = await adminPost('/admin/native-policy', {
      channel: 'dev',
      minSupportedNativeVersion: -3,
      severity: 'hard',
    });
    assert.equal(badMin.status, 400);

    // Both accepted schemes still work, and the policy is left harmless afterwards.
    for (const storeUrl of [
      'https://play.google.com/store/apps/details?id=com.x',
      'market://details?id=com.x',
      'itms-apps://itunes.apple.com/app/id1',
    ]) {
      const ok = await adminPost('/admin/native-policy', {
        channel: 'dev',
        minSupportedNativeVersion: 0,
        severity: 'soft',
        storeUrl,
      });
      assert.equal(ok.status, 200, `storeUrl ${storeUrl} must be accepted`);
    }
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

  await check('a crash-loop failure is accepted for a release that is no longer offered', async () => {
    // 0.4.1 reports `failed` on the launch after the native revert: the bundle is no longer current,
    // and bnd_R2_bad is paused, so the check offers bnd_R2_v1 instead.
    const dev = await enroll('install-crashloop', 'R2');
    const reverted = await checkThenConfirm(dev, { bundleId: 'bnd_R2_bad', status: 'failed' });
    assert.equal(reverted.check.update?.manifest.bundleId, 'bnd_R2_v1');
    assert.equal(reverted.res.status, 200, await reverted.res.text());
    // Only `failed` gets that allowance, and only for a release newer than the one reported running.
    assert.equal((await checkThenConfirm(dev, { bundleId: 'bnd_R2_bad', status: 'healthy' })).res.status, 401);
    const older = await checkThenConfirm(dev, { bundleId: 'bnd_R2_v1', status: 'failed' }, { currentBundleVersion: 3 });
    assert.equal(older.res.status, 401);
  });

  await check('one install counts once towards auto-pause, however many checks it makes', async () => {
    await publishRelease({
      bundleId: 'bnd_dedupe',
      runtimeVersion: 'R_DEDUPE',
      bundleVersion: 1,
      platform: 'android',
      channel: 'dev',
      appId: 'com.example.app',
      mandatory: false,
      files: bundleFiles,
      bundlePath: 'index.android.bundle',
      keyId,
    });
    const releaseState = async (): Promise<{ paused: boolean; adoption: Record<string, number> } | undefined> => {
      const listed = (await (await adminGet('/admin/releases')).json()) as {
        releases: { bundleId: string; paused: boolean; adoption: Record<string, number> }[];
      };
      return listed.releases.find((r) => r.bundleId === 'bnd_dedupe');
    };
    const dev = await enroll('install-dedupe', 'R_DEDUPE');
    for (let i = 0; i < 4; i++) {
      const { res } = await checkThenConfirm(dev, { bundleId: 'bnd_dedupe', status: 'failed' }, { runtimeVersion: 'R_DEDUPE' });
      assert.equal(res.status, 200);
    }
    const rolledBack = await checkThenConfirm(
      dev,
      { bundleId: 'bnd_dedupe', status: 'rolled_back' },
      { runtimeVersion: 'R_DEDUPE', currentBundleId: 'bnd_dedupe', currentBundleVersion: 1 },
    );
    assert.equal(rolledBack.res.status, 200);
    const single = await releaseState();
    assert.deepEqual([single?.adoption.failed, single?.adoption.rolled_back, single?.paused], [1, 0, false]);

    // A second install's failure does count (autoPauseMinSamples is 2 here).
    const other = await enroll('install-dedupe-2', 'R_DEDUPE');
    await checkThenConfirm(other, { bundleId: 'bnd_dedupe', status: 'failed' }, { runtimeVersion: 'R_DEDUPE' });
    assert.equal((await releaseState())?.paused, true);
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

  await check('an undecodable path parameter is a 400, and the server stays up', async () => {
    const res = await fetch(`${base}/ota/v2/releases/%/blobs/x`);
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { code: string }).code, 'bad_request');
    assert.equal((await fetch(`${base}/health`)).status, 200);
  });

  await check('HEAD /health and /ready answer 200 without a body', async () => {
    for (const path of ['/health', '/ready']) {
      const res = await fetch(`${base}${path}`, { method: 'HEAD' });
      assert.equal(res.status, 200, path);
      assert.equal(await res.text(), '');
    }
  });

  await check('an unknown route is answered before its body is read', async () => {
    // The body is declared at 300 MB and never sent: only a response sent before reading it arrives.
    const answer = await new Promise<{ status: number; connection?: string }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no response before the body was sent')), 5000);
      const req = request({
        host: 'localhost',
        port,
        method: 'POST',
        path: '/no/such/route',
        headers: { 'content-type': 'application/json', 'content-length': String(300 * 1024 * 1024) },
      });
      req.on('error', () => undefined);
      req.on('response', (res) => {
        clearTimeout(timer);
        resolve({ status: res.statusCode ?? 0, connection: res.headers.connection });
        req.destroy();
      });
      req.flushHeaders();
    });
    assert.deepEqual(answer, { status: 404, connection: 'close' });
  });

  await check('an unknown route with a small body gets a clean 404 on a kept-alive connection', async () => {
    const res = await fetch(`${base}/no/such/route`, { method: 'POST', body: JSON.stringify({ hello: 'x'.repeat(1024) }) });
    assert.equal(res.status, 404);
    assert.notEqual(res.headers.get('connection'), 'close');
    assert.equal(((await res.json()) as { code: string }).code, 'not_found');
  });

  await check('a device body over 64 KiB is a 413 JSON and the connection is closed', async () => {
    const res = await fetch(`${base}/ota/v2/enroll`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ installId: 'install-big-body', pad: 'a'.repeat(70 * 1024) }),
    });
    assert.equal(res.status, 413);
    assert.equal(res.headers.get('connection'), 'close');
    assert.equal(((await res.json()) as { code: string }).code, 'too_large');
  });

  await check('admin bodies get the larger cap only with the admin token', async () => {
    const post = (size: number, token?: string): Promise<Response> =>
      fetch(`${base}/admin/releases`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(token ? { 'x-ota-admin-token': token } : {}) },
        body: JSON.stringify({ signedManifest: { pad: 'a'.repeat(size) } }),
      });
    assert.equal((await post(100 * 1024, ADMIN)).status, 400, 'past the device cap, under maxAdminBodyBytes');
    assert.equal((await post(100 * 1024)).status, 413, 'an anonymous caller gets the device cap');
    assert.equal((await post(600 * 1024, ADMIN)).status, 413, 'past maxAdminBodyBytes');
  });

  await check('an over-cap blob upload gets a 413 JSON, not a connection reset', async () => {
    const built = await buildReleaseV2({
      contentKey: TEST_CONTENT_KEY,
      bundleId: 'bnd_overcap',
      runtimeVersion: 'R_OVERCAP',
      bundleVersion: 1,
      platform: 'android',
      channel: 'dev',
      appId: 'com.example.app',
      mandatory: false,
      files: uniqueFiles('overcap'),
      bundlePath: 'index.android.bundle',
      keyId,
    });
    const signed = signManifest(built.manifest, keys.privateKeyPem);
    const created = await adminPost('/admin/releases', { signedManifest: signed, rolloutPercentage: 100 });
    const { missing } = (await created.json()) as { missing: string[] };
    const url = `${base}/admin/releases/bnd_overcap/blobs/${missing[0]}`;
    const headers = { 'x-ota-admin-token': ADMIN, 'content-type': 'application/octet-stream' };
    const tooBig = new Uint8Array(64 * 1024).fill(1); // maxBlobBytes is 8 KiB here
    const declared = await fetch(url, { method: 'PUT', headers, body: tooBig });
    // No Content-Length: the cap trips while the stream is being spooled.
    const streamed = await fetch(url, {
      method: 'PUT',
      headers,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(tooBig);
          controller.close();
        },
      }),
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });
    for (const res of [declared, streamed]) {
      assert.equal(res.status, 413);
      assert.equal(((await res.json()) as { code: string }).code, 'too_large');
    }
  });

  await check('malformed or empty bodies are a 400 bad_request, not a 500', async () => {
    const admin = { 'x-ota-admin-token': ADMIN };
    const cases: [string, string, Record<string, string>][] = [
      ['/ota/v2/enroll', '{not json', {}],
      ['/ota/v2/enroll', '', {}],
      ['/admin/native-policy', '{not json', admin],
      ['/admin/rollout', '', admin],
      ['/admin/rollout', '[]', admin],
      ['/admin/pause', '{"bundleId":"bnd_R2_v1","paused":"yes"}', admin],
    ];
    for (const [path, body, extra] of cases) {
      const res = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...extra },
        body,
      });
      const data = (await res.json()) as { code?: string };
      assert.equal(res.status, 400, `${path} ${JSON.stringify(body)} -> ${JSON.stringify(data)}`);
      assert.equal(data.code, 'bad_request');
    }
  });

  await check('confirm rejects an unknown status, and adoption keeps only its four counters', async () => {
    const dev = await enroll('install-bad-status', 'R2');
    const { res } = await checkThenConfirm(dev, { bundleId: 'bnd_R2_v1', status: 'constructor' });
    assert.equal(res.status, 400);
    const listed = (await (await adminGet('/admin/releases')).json()) as {
      releases: { bundleId: string; adoption: Record<string, number> }[];
    };
    const adoption = listed.releases.find((r) => r.bundleId === 'bnd_R2_v1')?.adoption ?? {};
    assert.deepEqual(Object.keys(adoption).sort(), ['applied', 'failed', 'healthy', 'rolled_back']);
  });

  await check('a throwing or rejecting onConfirm hook is logged and never changes the response', async () => {
    const errors: string[] = [];
    let unhandled = 0;
    const onUnhandled = (): void => {
      unhandled += 1;
    };
    process.on('unhandledRejection', onUnhandled);
    config.logger = { info: () => undefined, warn: () => undefined, error: (message) => errors.push(message) };
    try {
      const hooks = [
        () => {
          throw new Error('sync hook boom');
        },
        async () => {
          throw new Error('async hook boom');
        },
      ];
      for (const [i, hook] of hooks.entries()) {
        config.onConfirm = hook;
        const dev = await enroll(`install-hook-${i}`, 'R2');
        const { res } = await checkThenConfirm(dev, { bundleId: 'bnd_R2_v1', status: 'applied' });
        assert.equal(res.status, 200);
        assert.deepEqual(await res.json(), { ok: true, autoPaused: false });
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    } finally {
      process.off('unhandledRejection', onUnhandled);
      delete config.onConfirm;
      delete config.logger;
    }
    assert.equal(unhandled, 0);
    assert.ok(
      errors.some((m) => m.includes('sync hook boom')),
      errors.join('\n'),
    );
    assert.ok(
      errors.some((m) => m.includes('async hook boom')),
      errors.join('\n'),
    );
  });

  await check('the v1 tombstone persists only a known platform and a well-formed channel', async () => {
    const tomb = (body: unknown): Promise<Response> =>
      fetch(`${base}/ota/v1/check`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    for (const body of [
      { channel: 'dev', platform: 'x' },
      { channel: 'bad channel!', platform: 'plan9' },
      { channel: 'c'.repeat(65), platform: 'ios' },
    ]) {
      const res = await tomb(body);
      assert.equal(res.status, 200);
      assert.equal(((await res.json()) as CheckResponse).nativePolicy.severity, 'hard');
    }
    assert.equal((await tomb({ channel: 'B'.repeat(100 * 1024), platform: 'android' })).status, 413);
    const listed = (await (await adminGet('/admin/releases')).json()) as { retiredClients: Record<string, number> };
    const keys = Object.keys(listed.retiredClients);
    assert.ok(
      keys.every((k) => /^[A-Za-z0-9._-]{1,64}\/(android|ios)$/.test(k)),
      keys.join(', '),
    );
  });

  await check('native-policy rejects smuggled store URLs and malformed fields', async () => {
    const valid = { channel: 'dev', minSupportedNativeVersion: 1, severity: 'hard' };
    const invalid: Record<string, unknown>[] = [
      { storeUrl: ['https://x', 'javascript:alert(1)'] },
      { storeUrl: 'https://play.google.com@evil.example/' },
      { storeUrl: 'https://x\njavascript:alert(1)' },
      { storeUrl: 'https://x y' },
      { storeUrl: 'https://x\u0000' },
      { channel: 'bad channel' },
      { channel: ['dev'] },
      { channel: 'c'.repeat(65) },
      { minSupportedNativeVersion: 1.5 },
      { minSupportedNativeVersion: 2 ** 60 },
      { minSupportedNativeVersion: '3' },
    ];
    for (const override of invalid) {
      const res = await adminPost('/admin/native-policy', { ...valid, ...override });
      assert.equal(res.status, 400, JSON.stringify(override));
    }
  });

  await check('a stored storeUrl that fails validation is not served', async () => {
    // As written by a version that stored any string.
    await store.setNativePolicy('uat', {
      minSupportedNativeVersion: 99,
      severity: 'hard',
      storeUrl: 'https://x\njavascript:alert(1)',
    });
    const dev = await enroll('install-legacy-policy', 'R2');
    const checked = (await (await signedPost('/ota/v2/check', checkBody(dev, { channel: 'uat' }), dev)).json()) as CheckResponse;
    assert.equal(checked.nativePolicy.severity, 'hard');
    assert.equal(checked.nativePolicy.storeUrl, undefined);
    const tomb = (await (
      await fetch(`${base}/ota/v1/check`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ channel: 'uat', platform: 'android' }),
      })
    ).json()) as CheckResponse;
    assert.equal(tomb.nativePolicy.storeUrl, undefined);
    await store.setNativePolicy('uat', { minSupportedNativeVersion: 0, severity: 'soft' });
  });

  await check('an explicit undefined option keeps the fail-closed default', async () => {
    const defaults = loadConfig();
    const resolved = resolveBackendConfig({
      requireRequestSignature: undefined,
      requireEnrollAuth: undefined,
      adminToken: undefined,
    });
    assert.equal(resolved.requireRequestSignature, defaults.requireRequestSignature);
    assert.equal(resolved.requireEnrollAuth, defaults.requireEnrollAuth);
    assert.equal(resolved.adminToken, defaults.adminToken);
  });

  await check('disk directories default outside the package and never inside node_modules', async () => {
    if (!process.env.OTA_STORAGE_DIR) assert.equal(loadConfig().storageDir, join(process.cwd(), '.dash-ota', 'storage'));
    if (!process.env.OTA_DATA_DIR) assert.equal(loadConfig().dataDir, join(process.cwd(), '.dash-ota', 'data'));
    assert.throws(
      () => new Store({ ...config, dataDir: join(tmp, 'node_modules', 'pkg', '.data') }),
      /dataDir resolves inside node_modules/,
    );
    assert.throws(
      () => new Store({ ...config, storageDir: join(tmp, 'node_modules', 'pkg', 'storage') }),
      /storageDir resolves inside node_modules/,
    );
    const logged: string[] = [];
    const logger = { info: (m: string) => logged.push(m), warn: () => undefined, error: () => undefined };
    assert.ok(new Store({ ...config, storageDir: join(tmp, 'logged-storage'), dataDir: join(tmp, 'logged-data'), logger }));
    assert.ok(
      logged.some((m) => m.includes(join(tmp, 'logged-storage'))),
      logged.join('\n'),
    );
    assert.ok(
      logged.some((m) => m.includes(join(tmp, 'logged-data'))),
      logged.join('\n'),
    );
  });

  await check('the standalone entry check matches through symlinks and paths with spaces', async () => {
    const dir = join(tmp, 'dir with spaces');
    mkdirSync(dir);
    const real = join(dir, 'server.js');
    writeFileSync(real, '');
    const link = join(tmp, 'linked bin');
    symlinkSync(dir, link);
    const moduleUrl = pathToFileURL(realpathSync(real)).href;
    assert.equal(isEntryPoint(moduleUrl, join(link, 'server.js')), true);
    assert.equal(isEntryPoint(moduleUrl, real), true);
    assert.equal(isEntryPoint(moduleUrl, join(tmp, 'missing.js')), false);
    assert.equal(isEntryPoint(moduleUrl, undefined), false);
  });

  // Last: its failures put this client address over the enroll-failure budget for the window.
  await check('failed enroll attempts cannot lock a real install out', async () => {
    const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const devicePublicKeyB64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    const attempt = (enrollToken?: string): Promise<Response> =>
      fetch(`${base}/ota/v2/enroll`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          installId: 'install-lockout-victim',
          platform: 'android',
          channel: 'dev',
          devicePublicKeyB64,
          enrollToken,
        }),
      });
    const codes: number[] = [];
    for (let i = 0; i < 10; i++) codes.push((await attempt()).status);
    assert.deepEqual([...new Set(codes)], [401, 429], 'failures are limited per client address');
    assert.equal((await attempt('test-session')).status, 200, 'the real install still enrolls');
  });

  server.close();
  console.log(`\n${passed} e2e checks passed.`);
}

void main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
