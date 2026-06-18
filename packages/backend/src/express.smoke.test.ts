/**
 * Smoke test for the Express adapter: mounts {@link dashOtaMiddleware} inside a real Express
 * app **behind a global `express.json({ verify: rawBodySaver })`** — the hardest case, where a
 * body parser runs first — and proves the full signed flow still verifies (raw bytes captured),
 * that the `verifyEnrollToken` hook gates enrollment, and that co-located app routes still work.
 *
 * Run: `npm -w @dash-ota/backend run smoke:express`.
 *
 * @module express.smoke.test
 */

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, type KeyObject, sign as nodeSign } from 'node:crypto';
import express from 'express';
import {
  buildRelease,
  type CheckResponse,
  generateSigningKeyPair,
  OTA_HEADERS,
  randomNonceB64,
  requestSigningString,
  sha256Hex,
  signManifest,
} from '@dash-ota/shared';
import { rawBodySaver, dashOtaMiddleware } from './index.js';

const ADMIN = 'smoke-admin-token';
let passed = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function deviceSign(privateKey: KeyObject, signingStr: string): string {
  return nodeSign('sha256', Buffer.from(signingStr, 'utf8'), privateKey).toString('base64');
}

async function main(): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), 'dash-ota-express-'));
  const onConfirm: string[] = [];

  const app = express();
  // A global JSON parser runs BEFORE the OTA middleware — rawBodySaver keeps the exact bytes
  // the client signed, so request-signature verification still works.
  app.use(express.json({ verify: rawBodySaver }));
  app.get('/', (_req, res) => res.json({ service: 'host-app' }));
  app.use(
    dashOtaMiddleware({
      adminToken: ADMIN,
      storageDir: join(tmp, 'storage'),
      dataDir: join(tmp, 'data'),
      requireRequestSignature: true,
      verifyEnrollToken: (token) => token === 'good-session',
      onConfirm: (e) => onConfirm.push(`${e.bundleId}:${e.status}`),
    }),
  );

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  const base = `http://localhost:${port}`;

  const keys = generateSigningKeyPair();
  const keyId = 'key_dev_1';

  async function adminPost(path: string, body: unknown): Promise<Response> {
    return fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ota-admin-token': ADMIN },
      body: JSON.stringify(body),
    });
  }

  interface Install {
    id: string;
    privateKey: KeyObject;
  }
  async function enroll(id: string, enrollToken: string): Promise<Response & { install?: Install }> {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const devicePublicKeyB64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    const res = await fetch(`${base}/ota/v1/enroll`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ installId: id, platform: 'android', channel: 'dev', appVersion: '1.0.0', buildNumber: 10, devicePublicKeyB64, enrollToken }),
    });
    return Object.assign(res, res.ok ? { install: { id, privateKey } } : {});
  }

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

  console.log('dash-ota express adapter smoke\n');

  await check("host app's own route still serves (fall-through to next())", async () => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { service: string }).service, 'host-app');
  });

  await check('admin registers key + publishes a release through Express', async () => {
    assert.equal((await adminPost('/admin/keys', { keyId, publicKeyRawB64: keys.publicKeyRawB64 })).status, 200);
    const built = buildRelease({
      bundleId: 'bnd_x_v1',
      runtimeVersion: 'R1',
      bundleVersion: 1,
      platform: 'android',
      channel: 'dev',
      mandatory: false,
      files: [{ path: 'index.android.bundle', data: Buffer.from('var v = 1;', 'utf8') }],
      keyId,
    });
    const signed = signManifest(built.manifest, keys.privateKeyPem);
    const res = await adminPost('/admin/publish', { signedManifest: signed, ciphertextB64: built.ciphertext.toString('base64'), rolloutPercentage: 100 });
    assert.equal(res.status, 200, await res.text());
  });

  await check('verifyEnrollToken hook rejects a bad session token (401)', async () => {
    const res = await enroll('inst-bad', 'nope');
    assert.equal(res.status, 401);
  });

  let device: Install;
  await check('verifyEnrollToken hook accepts a good session token (200)', async () => {
    const res = await enroll('inst-good', 'good-session');
    assert.equal(res.status, 200);
    assert.ok(res.install, 'expected an install handle');
    device = res.install!;
  });

  let serverNonce = '';
  await check('signed /check verifies over raw bytes (behind express.json) and returns the update', async () => {
    const res = await signedPost(
      '/ota/v1/check',
      { installId: device.id, platform: 'android', channel: 'dev', runtimeVersion: 'R1', appVersion: '1.0.0', buildNumber: 10, currentBundleVersion: 0 },
      device,
    );
    const data = (await res.json()) as CheckResponse;
    assert.equal(res.status, 200, JSON.stringify(data));
    assert.equal(data.update?.manifest.bundleId, 'bnd_x_v1');
    serverNonce = data.serverNonce;
  });

  await check('forged signature is rejected through the Express path (401)', async () => {
    const raw = Buffer.from(JSON.stringify({ installId: device.id, platform: 'android', channel: 'dev', runtimeVersion: 'R1', buildNumber: 10, currentBundleVersion: 0 }), 'utf8');
    const res = await fetch(`${base}/ota/v1/check`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [OTA_HEADERS.installId]: device.id,
        [OTA_HEADERS.nonce]: randomNonceB64(),
        [OTA_HEADERS.timestamp]: String(Date.now()),
        [OTA_HEADERS.signature]: 'deadbeef',
      },
      body: raw,
    });
    assert.equal(res.status, 401);
  });

  await check('confirm fires the onConfirm hook', async () => {
    const res = await signedPost('/ota/v1/confirm', { installId: device.id, bundleId: 'bnd_x_v1', runtimeVersion: 'R1', status: 'healthy', serverNonce }, device);
    assert.equal(res.status, 200, await res.text());
    assert.ok(onConfirm.includes('bnd_x_v1:healthy'), 'expected onConfirm hook to record the event');
  });

  server.close();
  console.log(`\n${passed} express-adapter checks passed.`);
}

void main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
