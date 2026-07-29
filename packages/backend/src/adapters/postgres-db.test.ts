/**
 * Integration test for {@link PostgresDatabaseProvider} against a real Postgres. It **skips
 * cleanly** when `OTA_TEST_DATABASE_URL` is unset, so `npm run ci` is green with no infra; point
 * it at a database (local or a CI service) to actually exercise the adapter:
 *
 * ```sh
 * OTA_TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres npm run test:postgres
 * ```
 *
 * It writes to the `ota_*` tables (created on first use) and cleans up its own rows afterwards.
 *
 * @module adapters/postgres-db.test
 */

import assert from 'node:assert/strict';
import type { SignedManifest } from '@dash-ota/shared';
import { PostgresDatabaseProvider, type PgLike } from './postgres-db.js';
import type { ReleaseRecord } from '../providers.js';

const url = process.env.OTA_TEST_DATABASE_URL;

/** A minimal ReleaseRecord for round-trip testing (only the fields the provider persists matter). */
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
  if (!url) {
    console.log('postgres adapter integration test skipped (set OTA_TEST_DATABASE_URL to run)');
    return;
  }

  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: url });
  const db = new PostgresDatabaseProvider({ client: pool as unknown as PgLike });
  const id = `bnd_pgtest_${process.pid}`;
  let passed = 0;
  const check = async (name: string, fn: () => Promise<void>): Promise<void> => {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  };

  console.log('dash-ota postgres db adapter\n');

  try {
    await check('release upsert round-trips (insert then overwrite)', async () => {
      assert.equal(await db.getRelease(id), null);
      await db.putRelease(fixtureRelease(id));
      assert.equal((await db.getRelease(id))?.bundleVersion, 1);
      const updated = fixtureRelease(id);
      updated.bundleVersion = 2;
      updated.paused = true;
      await db.putRelease(updated);
      const got = await db.getRelease(id);
      assert.equal(got?.bundleVersion, 2);
      assert.equal(got?.paused, true);
    });

    await check('listReleases includes the row', async () => {
      const all = await db.listReleases();
      assert.ok(all.some((r) => r.bundleId === id));
    });

    await check('install + trusted key + native policy round-trip', async () => {
      await db.putInstall({ installId: id, devicePublicKeyB64: 'pk', platform: 'android', channel: 'dev', createdAt: 'now' });
      assert.equal((await db.getInstall(id))?.devicePublicKeyB64, 'pk');
      await db.putTrustedKey(id, 'rawpub');
      assert.equal(await db.getTrustedKey(id), 'rawpub');
      await db.putNativePolicy(id, { minSupportedNativeVersion: 5, severity: 'hard' });
      assert.equal((await db.getNativePolicy(id))?.minSupportedNativeVersion, 5);
    });
  } finally {
    // clean up this test's own rows
    await pool.query('DELETE FROM ota_releases WHERE bundle_id = $1', [id]);
    await pool.query('DELETE FROM ota_installs WHERE install_id = $1', [id]);
    await pool.query('DELETE FROM ota_trusted_keys WHERE key_id = $1', [id]);
    await pool.query('DELETE FROM ota_native_policies WHERE channel = $1', [id]);
    await pool.end();
  }

  console.log(`\n${passed} postgres checks passed.`);
}

void main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
