/**
 * Integration test for {@link S3BlobStore} against a real S3-compatible store (AWS S3, R2, MinIO).
 * It **skips cleanly** when `OTA_TEST_S3_BUCKET` is unset, so `npm run ci` is green with no infra.
 * To run against MinIO locally, for example:
 *
 * ```sh
 * OTA_TEST_S3_BUCKET=dash-ota-test OTA_TEST_S3_ENDPOINT=http://localhost:9000 \
 * OTA_TEST_S3_FORCE_PATH_STYLE=true AWS_REGION=us-east-1 \
 * AWS_ACCESS_KEY_ID=minioadmin AWS_SECRET_ACCESS_KEY=minioadmin npm run test:s3
 * ```
 *
 * It writes + deletes its own object key.
 *
 * @module adapters/s3-blob.test
 */

import assert from 'node:assert/strict';
import { S3BlobStore } from './s3-blob.js';

const bucket = process.env.OTA_TEST_S3_BUCKET;

async function main(): Promise<void> {
  if (!bucket) {
    console.log('s3 adapter integration test skipped (set OTA_TEST_S3_BUCKET to run)');
    return;
  }

  const blob = new S3BlobStore({
    bucket,
    region: process.env.AWS_REGION,
    endpoint: process.env.OTA_TEST_S3_ENDPOINT,
    forcePathStyle: process.env.OTA_TEST_S3_FORCE_PATH_STYLE === 'true',
    prefix: `dash-ota-test-${process.pid}/`,
  });
  const id = `bnd_s3test_${process.pid}`;
  const payload = Buffer.from('ciphertext-bytes-for-s3-roundtrip', 'utf8');
  let passed = 0;
  const check = async (name: string, fn: () => Promise<void>): Promise<void> => {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  };

  console.log('dash-ota s3 blob store adapter\n');

  await check('missing object → null for stat/get/stream', async () => {
    assert.equal(await blob.stat(id), null);
    assert.equal(await blob.get(id), null);
    assert.equal(await blob.openReadStream(id), null);
  });

  await check('put then stat reports the exact size', async () => {
    await blob.put(id, payload);
    assert.deepEqual(await blob.stat(id), { size: payload.byteLength });
  });

  await check('get round-trips the bytes; stream yields the same', async () => {
    const got = await blob.get(id);
    assert.ok(got && got.equals(payload));
    const stream = await blob.openReadStream(id);
    assert.ok(stream, 'expected a stream');
    const chunks: Buffer[] = [];
    for await (const c of stream!) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c as Uint8Array));
    assert.ok(Buffer.concat(chunks).equals(payload));
  });

  // clean up
  const mod = await import('@aws-sdk/client-s3');
  const client = new mod.S3Client({
    region: process.env.AWS_REGION,
    endpoint: process.env.OTA_TEST_S3_ENDPOINT,
    forcePathStyle: process.env.OTA_TEST_S3_FORCE_PATH_STYLE === 'true',
  });
  await client.send(new mod.DeleteObjectCommand({ Bucket: bucket, Key: `dash-ota-test-${process.pid}/${id}.bin` }));

  console.log(`\n${passed} s3 checks passed.`);
}

void main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
