/**
 * Integration test for {@link RedisCacheProvider} against a real Redis. It **skips cleanly** when
 * `OTA_TEST_REDIS_URL` is unset, so `npm run ci` is green with no infra; point it at a Redis
 * (local or a CI service) to actually exercise the adapter:
 *
 * ```sh
 * OTA_TEST_REDIS_URL=redis://localhost:6379 npm run test:redis
 * ```
 *
 * @module adapters/redis-cache.test
 */

import assert from 'node:assert/strict';
import { RedisCacheProvider, type RedisLike } from './redis-cache.js';

const url = process.env.OTA_TEST_REDIS_URL;

async function main(): Promise<void> {
  if (!url) {
    console.log('redis adapter integration test skipped (set OTA_TEST_REDIS_URL to run)');
    return;
  }

  const { Redis } = await import('ioredis');
  const client = new Redis(url);
  const cache = new RedisCacheProvider({ client: client as unknown as RedisLike, keyPrefix: `dashota-test-${process.pid}:` });
  let passed = 0;
  const check = async (name: string, fn: () => Promise<void>): Promise<void> => {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  };

  console.log('dash-ota redis cache adapter\n');

  await check('nonce is fresh once, then a replay', async () => {
    const n = `n-${process.pid}-1`;
    assert.equal(await cache.registerNonce(n, 5000), true);
    assert.equal(await cache.registerNonce(n, 5000), false);
  });

  await check('one-time token yields its value exactly once (GETDEL)', async () => {
    const t = `t-${process.pid}-1`;
    await cache.putToken(t, 'bundle-xyz', 5000);
    assert.equal(await cache.consumeToken(t), 'bundle-xyz');
    assert.equal(await cache.consumeToken(t), null);
  });

  await check('fixed-window rate limit trips at the limit', async () => {
    const k = `k-${process.pid}-1`;
    const first = await cache.rateLimit(k, 2, 5000);
    assert.equal(first.allowed, true);
    assert.equal(first.remaining, 1);
    assert.equal((await cache.rateLimit(k, 2, 5000)).allowed, true);
    const third = await cache.rateLimit(k, 2, 5000);
    assert.equal(third.allowed, false);
    assert.ok(third.resetMs > 0 && third.resetMs <= 5000, 'resetMs within the window');
  });

  await client.quit();
  console.log(`\n${passed} redis checks passed.`);
}

void main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
