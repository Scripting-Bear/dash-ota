/**
 * SQLite-backed {@link DatabaseProvider} — a durable, ACID, **single-file** metadata store that
 * needs no server. The sweet spot between the Disk-JSON default (not concurrency-safe) and a full
 * Postgres deployment: perfect for a single-node production install.
 *
 * Same three tiers as the rest of dash-ota:
 *
 * 1. **Beginner** — don't use this; the Disk default works out of the box.
 * 2. **Upgrade (one line)** — set `sqlitePath` (or `OTA_SQLITE_PATH`) and the backend wires this
 *    adapter, creating the file + schema on first use. `better-sqlite3` is an *optional* peer
 *    (a **native** module), loaded lazily; a default install never pulls it in.
 * 3. **Advanced** — inject your own opened database: `new SqliteDatabaseProvider({ client: db })`.
 *
 * `better-sqlite3` is synchronous; its calls are wrapped in the async interface. WAL journal mode
 * is enabled for better read/write concurrency on a single node.
 *
 * @module adapters/sqlite-db
 */

import type { NativeVersionPolicy } from '@dash-ota/shared';
import type { DatabaseProvider, InstallRecord, ReleaseRecord } from '../providers.js';

/** The minimal slice of a `better-sqlite3` database this adapter uses — structural, so any db injects. */
export interface SqliteStatement {
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): unknown;
}
export interface SqliteLike {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): unknown;
  pragma(source: string): unknown;
}

/** Options for {@link SqliteDatabaseProvider}. Give a `client` (advanced) or a `path` (the one-liner). */
export interface SqliteDbOptions {
  /** Bring your own opened `better-sqlite3` database. Wins over `path`. */
  client?: SqliteLike;
  /** File path for the lazily-opened database (`':memory:'` is allowed). Default `dashota.sqlite`. */
  path?: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS ota_releases (
  bundle_id  TEXT PRIMARY KEY,
  data       TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ota_installs (
  install_id TEXT PRIMARY KEY,
  data       TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ota_trusted_keys (
  key_id     TEXT PRIMARY KEY,
  public_key TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ota_native_policies (
  channel TEXT PRIMARY KEY,
  data    TEXT NOT NULL
);
`;

/** SQLite-backed {@link DatabaseProvider}. See the module docs for the beginner/upgrade/advanced tiers. */
export class SqliteDatabaseProvider implements DatabaseProvider {
  private dbPromise?: Promise<SqliteLike>;

  constructor(private readonly opts: SqliteDbOptions = {}) {}

  /** Open the database, lazily importing `better-sqlite3`, applying pragmas + schema once (memoized). */
  private db(): Promise<SqliteLike> {
    if (!this.dbPromise) {
      this.dbPromise = (
        this.opts.client
          ? Promise.resolve(this.opts.client)
          : import('better-sqlite3')
              .catch(() => {
                throw new Error(
                  "dash-ota: the SQLite store needs the optional 'better-sqlite3' peer dependency — run `npm i better-sqlite3`.",
                );
              })
              .then((mod) => new mod.default(this.opts.path ?? 'dashota.sqlite') as unknown as SqliteLike)
      ).then((db) => {
        db.pragma('journal_mode = WAL');
        db.exec(SCHEMA);
        return db;
      });
    }
    return this.dbPromise;
  }

  async getRelease(bundleId: string): Promise<ReleaseRecord | null> {
    const db = await this.db();
    const row = db.prepare('SELECT data FROM ota_releases WHERE bundle_id = ?').get(bundleId) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as ReleaseRecord) : null;
  }

  async listReleases(): Promise<ReleaseRecord[]> {
    const db = await this.db();
    const rows = db.prepare('SELECT data FROM ota_releases').all() as Array<{ data: string }>;
    return rows.map((r) => JSON.parse(r.data) as ReleaseRecord);
  }

  async putRelease(record: ReleaseRecord): Promise<void> {
    const db = await this.db();
    db.prepare(
      `INSERT INTO ota_releases (bundle_id, data, created_at) VALUES (?, ?, ?)
       ON CONFLICT(bundle_id) DO UPDATE SET data = excluded.data, created_at = excluded.created_at`,
    ).run(record.bundleId, JSON.stringify(record), record.createdAt);
  }

  async getInstall(installId: string): Promise<InstallRecord | null> {
    const db = await this.db();
    const row = db.prepare('SELECT data FROM ota_installs WHERE install_id = ?').get(installId) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as InstallRecord) : null;
  }

  async putInstall(record: InstallRecord): Promise<void> {
    const db = await this.db();
    db.prepare(
      `INSERT INTO ota_installs (install_id, data) VALUES (?, ?)
       ON CONFLICT(install_id) DO UPDATE SET data = excluded.data`,
    ).run(record.installId, JSON.stringify(record));
  }

  async getTrustedKey(keyId: string): Promise<string | null> {
    const db = await this.db();
    const row = db.prepare('SELECT public_key FROM ota_trusted_keys WHERE key_id = ?').get(keyId) as
      { public_key: string } | undefined;
    return row ? row.public_key : null;
  }

  async putTrustedKey(keyId: string, publicKeyRawB64: string): Promise<void> {
    const db = await this.db();
    db.prepare(
      `INSERT INTO ota_trusted_keys (key_id, public_key) VALUES (?, ?)
       ON CONFLICT(key_id) DO UPDATE SET public_key = excluded.public_key`,
    ).run(keyId, publicKeyRawB64);
  }

  async getNativePolicy(channel: string): Promise<NativeVersionPolicy | null> {
    const db = await this.db();
    const row = db.prepare('SELECT data FROM ota_native_policies WHERE channel = ?').get(channel) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as NativeVersionPolicy) : null;
  }

  async putNativePolicy(channel: string, policy: NativeVersionPolicy): Promise<void> {
    const db = await this.db();
    db.prepare(
      `INSERT INTO ota_native_policies (channel, data) VALUES (?, ?)
       ON CONFLICT(channel) DO UPDATE SET data = excluded.data`,
    ).run(channel, JSON.stringify(policy));
  }
}
