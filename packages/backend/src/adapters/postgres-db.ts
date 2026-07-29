/**
 * Postgres-backed {@link DatabaseProvider} — the durable, concurrency-safe upgrade for release /
 * install / trusted-key / native-policy metadata. The Disk default is fine for a single node but
 * rewrites whole JSON files (not safe for concurrent writers or >1 instance); Postgres gives you
 * ACID rows and atomic UPSERTs.
 *
 * Same three tiers as the rest of dash-ota:
 *
 * 1. **Beginner** — don't use this; the Disk default works out of the box.
 * 2. **Upgrade (one line)** — pass `databaseUrl` (or set `OTA_DATABASE_URL`) and the backend wires
 *    this adapter for you. `pg` is an *optional* peer dependency, loaded lazily on first use, so a
 *    default install never pulls it in. The schema is created automatically on first use — no
 *    migration step to get started.
 * 3. **Advanced** — construct it yourself with your own pool (PgBouncer, TLS, read replicas):
 *    `new PostgresDatabaseProvider({ client: myPgPool })`.
 *
 * Records are stored as `jsonb` keyed by their natural id, so the shape stays stable across
 * manifest changes without a migration.
 *
 * NOTE (concurrency): per-row writes are atomic UPSERTs, but the Store still does read-modify-write
 * for adoption counters (`recordConfirm`) — under heavy concurrent `/confirm` a counter increment
 * can be lost. Optimistic-locking that path is a tracked follow-up (affects every DatabaseProvider).
 *
 * @module adapters/postgres-db
 */

import type { NativeVersionPolicy } from '@dash-ota/shared';
import type { DatabaseProvider, InstallRecord, ReleaseRecord } from '../providers.js';

/** The minimal slice of a `pg` Pool/Client this adapter uses — kept structural so any pool injects. */
export interface PgLike {
  query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

/** Options for {@link PostgresDatabaseProvider}. Give a `client` (advanced) or a `url` (the one-liner). */
export interface PostgresDbOptions {
  /** Bring your own `pg` Pool/Client (PgBouncer, TLS, replicas). Wins over `url`. */
  client?: PgLike;
  /** Connection string for the lazily-created default pool, e.g. `postgres://user:pw@host/db`. */
  url?: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS ota_releases (
  bundle_id  text PRIMARY KEY,
  data       jsonb NOT NULL,
  created_at text  NOT NULL
);
CREATE TABLE IF NOT EXISTS ota_installs (
  install_id text PRIMARY KEY,
  data       jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS ota_trusted_keys (
  key_id     text PRIMARY KEY,
  public_key text NOT NULL
);
CREATE TABLE IF NOT EXISTS ota_native_policies (
  channel text PRIMARY KEY,
  data    jsonb NOT NULL
);
`;

/** Postgres-backed {@link DatabaseProvider}. See the module docs for the beginner/upgrade/advanced tiers. */
export class PostgresDatabaseProvider implements DatabaseProvider {
  private clientPromise?: Promise<PgLike>;
  private schemaReady?: Promise<void>;

  constructor(private readonly opts: PostgresDbOptions = {}) {}

  /** Resolve the pool, lazily importing `pg` and connecting on first use (memoized). */
  private client(): Promise<PgLike> {
    if (this.opts.client) return Promise.resolve(this.opts.client);
    if (!this.clientPromise) {
      this.clientPromise = import('pg')
        .catch(() => {
          throw new Error("dash-ota: the Postgres store needs the optional 'pg' peer dependency — run `npm i pg`.");
        })
        .then((mod) => new mod.default.Pool({ connectionString: this.opts.url }) as unknown as PgLike);
    }
    return this.clientPromise;
  }

  /** Create the schema on first use (idempotent, memoized) so there's no separate migration step. */
  private async ready(): Promise<PgLike> {
    const c = await this.client();
    if (!this.schemaReady) {
      this.schemaReady = c.query(SCHEMA).then(() => undefined);
    }
    await this.schemaReady;
    return c;
  }

  async getRelease(bundleId: string): Promise<ReleaseRecord | null> {
    const c = await this.ready();
    const [row] = (await c.query('SELECT data FROM ota_releases WHERE bundle_id = $1', [bundleId])).rows;
    return row ? (row.data as ReleaseRecord) : null;
  }

  async listReleases(): Promise<ReleaseRecord[]> {
    const c = await this.ready();
    const { rows } = await c.query('SELECT data FROM ota_releases', []);
    return rows.map((r) => r.data as ReleaseRecord);
  }

  async putRelease(record: ReleaseRecord): Promise<void> {
    const c = await this.ready();
    await c.query(
      `INSERT INTO ota_releases (bundle_id, data, created_at) VALUES ($1, $2::jsonb, $3)
       ON CONFLICT (bundle_id) DO UPDATE SET data = EXCLUDED.data, created_at = EXCLUDED.created_at`,
      [record.bundleId, JSON.stringify(record), record.createdAt],
    );
  }

  async getInstall(installId: string): Promise<InstallRecord | null> {
    const c = await this.ready();
    const [row] = (await c.query('SELECT data FROM ota_installs WHERE install_id = $1', [installId])).rows;
    return row ? (row.data as InstallRecord) : null;
  }

  async putInstall(record: InstallRecord): Promise<void> {
    const c = await this.ready();
    await c.query(
      `INSERT INTO ota_installs (install_id, data) VALUES ($1, $2::jsonb)
       ON CONFLICT (install_id) DO UPDATE SET data = EXCLUDED.data`,
      [record.installId, JSON.stringify(record)],
    );
  }

  async getTrustedKey(keyId: string): Promise<string | null> {
    const c = await this.ready();
    const [row] = (await c.query('SELECT public_key FROM ota_trusted_keys WHERE key_id = $1', [keyId])).rows;
    return row ? (row.public_key as string) : null;
  }

  async putTrustedKey(keyId: string, publicKeyRawB64: string): Promise<void> {
    const c = await this.ready();
    await c.query(
      `INSERT INTO ota_trusted_keys (key_id, public_key) VALUES ($1, $2)
       ON CONFLICT (key_id) DO UPDATE SET public_key = EXCLUDED.public_key`,
      [keyId, publicKeyRawB64],
    );
  }

  async getNativePolicy(channel: string): Promise<NativeVersionPolicy | null> {
    const c = await this.ready();
    const [row] = (await c.query('SELECT data FROM ota_native_policies WHERE channel = $1', [channel])).rows;
    return row ? (row.data as NativeVersionPolicy) : null;
  }

  async putNativePolicy(channel: string, policy: NativeVersionPolicy): Promise<void> {
    const c = await this.ready();
    await c.query(
      `INSERT INTO ota_native_policies (channel, data) VALUES ($1, $2::jsonb)
       ON CONFLICT (channel) DO UPDATE SET data = EXCLUDED.data`,
      [channel, JSON.stringify(policy)],
    );
  }
}
