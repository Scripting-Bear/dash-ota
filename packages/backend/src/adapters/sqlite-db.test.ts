/**
 * Integration test for {@link SqliteDatabaseProvider}. Unlike the Redis/Postgres/S3 suites this one
 * runs **unconditionally** against an in-memory SQLite database — `better-sqlite3` is a dev
 * dependency and needs no external service — so it gives real live adapter coverage in `npm run ci`.
 *
 * @module adapters/sqlite-db.test
 */

import assert from 'node:assert/strict';
import type { SignedManifest } from '@dash-ota/shared';
import { SqliteDatabaseProvider } from './sqlite-db.js';
import type { ReleaseRecord } from '../providers.js';

function fixtureRelease(bundleId: string): ReleaseRecord {
  return {
    bundleId,
    platform: 'android',
    channel: 'dev',
    runtimeVersion: 'R2',
    bundleVersion: 1,
    signedManifest: { manifest: { bundleId }, signatureB64: 'x', keyId: 'k' } as unknown as SignedManifest,
    rolloutPercentage: 100,
    paused: false,
    rolledBack: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    adoption: { applied: 0, healthy: 0, failed: 0, rolled_back: 0 },
  };
}

async function main(): Promise<void> {
  const db = new SqliteDatabaseProvider({ path: ':memory:' });
  let passed = 0;
  const check = async (name: string, fn: () => Promise<void>): Promise<void> => {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  };

  console.log('dash-ota sqlite db adapter\n');

  await check('release upsert round-trips (insert then overwrite)', async () => {
    assert.equal(await db.getRelease('bnd_1'), null);
    await db.putRelease(fixtureRelease('bnd_1'));
    assert.equal((await db.getRelease('bnd_1'))?.bundleVersion, 1);
    const updated = fixtureRelease('bnd_1');
    updated.bundleVersion = 2;
    updated.paused = true;
    await db.putRelease(updated);
    const got = await db.getRelease('bnd_1');
    assert.equal(got?.bundleVersion, 2);
    assert.equal(got?.paused, true);
  });

  await check('listReleases returns every stored release', async () => {
    await db.putRelease(fixtureRelease('bnd_2'));
    const all = await db.listReleases();
    assert.equal(all.length, 2);
    assert.deepEqual(all.map((r) => r.bundleId).sort(), ['bnd_1', 'bnd_2']);
  });

  await check('install + trusted key + native policy round-trip', async () => {
    await db.putInstall({ installId: 'i1', devicePublicKeyB64: 'pk', platform: 'android', channel: 'dev', createdAt: 'now' });
    assert.equal((await db.getInstall('i1'))?.devicePublicKeyB64, 'pk');
    assert.equal(await db.getInstall('missing'), null);
    await db.putTrustedKey('k1', 'rawpub');
    assert.equal(await db.getTrustedKey('k1'), 'rawpub');
    await db.putNativePolicy('dev', { minSupportedNativeVersion: 5, severity: 'hard' });
    assert.equal((await db.getNativePolicy('dev'))?.minSupportedNativeVersion, 5);
    assert.equal(await db.getNativePolicy('prod'), null);
  });

  console.log(`\n${passed} sqlite checks passed.`);
}

void main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
