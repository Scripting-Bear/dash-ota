/**
 * Redis-backed {@link CacheProvider} — the multi-instance upgrade for the ephemeral single-use
 * state (client-nonce replay guard, one-time download tokens, server nonces, rate-limit counters).
 * The in-memory default only protects one process; behind a load balancer you **need** a shared
 * cache for the anti-replay and rate-limit guarantees to actually hold.
 *
 * Three levels of effort, matching the rest of dash-ota:
 *
 * 1. **Beginner** — don't use this; the in-memory default is fine for a single node.
 * 2. **Upgrade (one line)** — pass `redisUrl` (or set `OTA_REDIS_URL`) and the backend wires this
 *    adapter for you. `ioredis` is an *optional* peer dependency, loaded lazily on first use — so
 *    a default install never pulls it in. If it's missing you get a clear "run `npm i ioredis`".
 * 3. **Advanced** — construct it yourself with your own client (Cluster / Sentinel / shared pool):
 *    `new RedisCacheProvider({ client: myIoredisClient })`.
 *
 * Requires Redis 6.2+ (uses `GETDEL` for the atomic one-time-token consume).
 *
 * @module adapters/redis-cache
 */

import type { CacheProvider, RateLimitResult } from '../providers.js';

/**
 * The minimal slice of an `ioredis` client this adapter uses. Kept structural so any compatible
 * client (a Cluster, a wrapped pool) can be injected without depending on the exact `ioredis` type.
 */
export interface RedisLike {
  set(key: string, value: string, ...args: (string | number)[]): Promise<unknown>;
  getdel(key: string): Promise<string | null>;
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
}

/** Options for {@link RedisCacheProvider}. Give a `client` (advanced) or a `url` (the one-line upgrade). */
export interface RedisCacheOptions {
  /** Bring your own client (Cluster / Sentinel / shared pool). Wins over `url`. */
  client?: RedisLike;
  /** Connection string for the lazily-created default client, e.g. `redis://localhost:6379`. */
  url?: string;
  /** Namespace prefix so multiple apps can share one Redis without key collisions. Default `dashota:`. */
  keyPrefix?: string;
}

// Atomic fixed-window counter: INCR, set the TTL only on the first hit of the window, return
// [count, pttl]. Doing it in one script avoids an orphaned (never-expiring) key if the process
// dies between INCR and PEXPIRE.
const RATE_LIMIT_LUA = `
local c = redis.call('INCR', KEYS[1])
if c == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return {c, redis.call('PTTL', KEYS[1])}
`;

/** Redis-backed {@link CacheProvider}. See the module docs for the beginner/upgrade/advanced tiers. */
export class RedisCacheProvider implements CacheProvider {
  private readonly prefix: string;
  private clientPromise?: Promise<RedisLike>;

  constructor(private readonly opts: RedisCacheOptions = {}) {
    this.prefix = opts.keyPrefix ?? 'dashota:';
  }

  /** Resolve the client, lazily importing `ioredis` and connecting on first use (memoized). */
  private client(): Promise<RedisLike> {
    if (this.opts.client) return Promise.resolve(this.opts.client);
    if (!this.clientPromise) {
      this.clientPromise = import('ioredis')
        .catch(() => {
          // Only the *import* failing means the optional peer is absent; construction errors
          // (e.g. a bad URL) must propagate as themselves, not be mislabelled as a missing dep.
          throw new Error("dash-ota: the Redis cache needs the optional 'ioredis' peer dependency — run `npm i ioredis`.");
        })
        .then((mod) => new mod.Redis(this.opts.url ?? 'redis://localhost:6379') as unknown as RedisLike);
    }
    return this.clientPromise;
  }

  async registerNonce(nonce: string, ttlMs: number): Promise<boolean> {
    const client = await this.client();
    // SET NX PX: succeeds ('OK') only if the nonce is unseen within the window — else it's a replay.
    const res = await client.set(`${this.prefix}nonce:${nonce}`, '1', 'PX', ttlMs, 'NX');
    return res === 'OK';
  }

  async putToken(token: string, value: string, ttlMs: number): Promise<void> {
    const client = await this.client();
    await client.set(`${this.prefix}tok:${token}`, value, 'PX', ttlMs);
  }

  async consumeToken(token: string): Promise<string | null> {
    const client = await this.client();
    // GETDEL is atomic — the value is returned to exactly one caller, enforcing single-use.
    return client.getdel(`${this.prefix}tok:${token}`);
  }

  async rateLimit(key: string, limit: number, windowMs: number): Promise<RateLimitResult> {
    const client = await this.client();
    const [count, pttl] = (await client.eval(RATE_LIMIT_LUA, 1, `${this.prefix}rl:${key}`, windowMs)) as [number, number];
    return { allowed: count <= limit, remaining: Math.max(0, limit - count), resetMs: pttl < 0 ? windowMs : pttl };
  }
}
