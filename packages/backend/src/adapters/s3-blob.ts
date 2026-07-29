/**
 * S3-compatible {@link BlobStore} — stores the encrypted bundle bytes in object storage (AWS S3,
 * Cloudflare R2, MinIO, …) instead of on local disk. The download path streams straight from the
 * object, so the backend never buffers a whole ciphertext in memory.
 *
 * Same three tiers as the rest of dash-ota:
 *
 * 1. **Beginner** — don't use this; the Disk default works out of the box.
 * 2. **Upgrade (one line)** — set `s3Bucket` (or `OTA_S3_BUCKET`) and the backend wires this
 *    adapter. `@aws-sdk/client-s3` is an *optional* peer dependency, loaded lazily on first use.
 *    Region/endpoint/credentials come from the standard AWS env chain, or set `s3Endpoint` +
 *    `s3ForcePathStyle` for R2 / MinIO.
 * 3. **Advanced** — inject your own configured client: `new S3BlobStore({ bucket, client })`.
 *
 * @module adapters/s3-blob
 */

import type { Readable } from 'node:stream';
import type { BlobStore } from '../providers.js';

/** The minimal slice of an S3 client this adapter uses — structural, so any configured client injects. */
export interface S3Like {
  send(command: unknown): Promise<Record<string, unknown>>;
}

/** Options for {@link S3BlobStore}. `bucket` is required; give a `client` (advanced) or connection fields. */
export interface S3BlobOptions {
  /** the bucket that holds the ciphertext objects. */
  bucket: string;
  /** Bring your own configured client (custom credentials/retries). Wins over the connection fields. */
  client?: S3Like;
  /** AWS region (or the region your S3-compatible endpoint expects). */
  region?: string;
  /** custom endpoint for S3-compatible stores (Cloudflare R2, MinIO, …). */
  endpoint?: string;
  /** path-style addressing — required by MinIO and some R2 setups. */
  forcePathStyle?: boolean;
  /** key prefix inside the bucket, e.g. `bundles/`. Default none. */
  prefix?: string;
}

type S3Module = typeof import('@aws-sdk/client-s3');

/** True for an S3 "key not found" error (HeadObject → `NotFound`, GetObject → `NoSuchKey`, or 404). */
function isNotFound(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === 'NotFound' || e?.name === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404;
}

/** Collect a Readable into a single Buffer (used by the buffered {@link BlobStore.get}). */
async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks);
}

/** S3-compatible {@link BlobStore}. See the module docs for the beginner/upgrade/advanced tiers. */
export class S3BlobStore implements BlobStore {
  private readonly prefix: string;
  private sdkPromise?: Promise<S3Module>;
  private clientInstance?: S3Like;

  constructor(private readonly opts: S3BlobOptions) {
    this.prefix = opts.prefix ?? '';
  }

  /** Lazily import the AWS SDK (needed for the Command classes even when a client is injected). */
  private sdk(): Promise<S3Module> {
    if (!this.sdkPromise) {
      this.sdkPromise = import('@aws-sdk/client-s3').catch(() => {
        throw new Error(
          "dash-ota: the S3 blob store needs the optional '@aws-sdk/client-s3' peer dependency — run `npm i @aws-sdk/client-s3`.",
        );
      });
    }
    return this.sdkPromise;
  }

  /** Resolve the client: injected one wins; else construct one from the connection fields (memoized). */
  private client(mod: S3Module): S3Like {
    if (this.opts.client) return this.opts.client;
    if (!this.clientInstance) {
      this.clientInstance = new mod.S3Client({
        region: this.opts.region,
        endpoint: this.opts.endpoint,
        forcePathStyle: this.opts.forcePathStyle,
      }) as unknown as S3Like;
    }
    return this.clientInstance;
  }

  private key(bundleId: string): string {
    return `${this.prefix}${bundleId}.bin`;
  }

  async put(bundleId: string, data: Buffer): Promise<void> {
    const mod = await this.sdk();
    await this.client(mod).send(
      new mod.PutObjectCommand({
        Bucket: this.opts.bucket,
        Key: this.key(bundleId),
        Body: data,
        ContentLength: data.byteLength,
        ContentType: 'application/octet-stream',
      }),
    );
  }

  async stat(bundleId: string): Promise<{ size: number } | null> {
    const mod = await this.sdk();
    try {
      const res = await this.client(mod).send(new mod.HeadObjectCommand({ Bucket: this.opts.bucket, Key: this.key(bundleId) }));
      return { size: Number(res.ContentLength ?? 0) };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async openReadStream(bundleId: string): Promise<Readable | null> {
    const mod = await this.sdk();
    try {
      const res = await this.client(mod).send(new mod.GetObjectCommand({ Bucket: this.opts.bucket, Key: this.key(bundleId) }));
      // In Node the SDK returns a stream.Readable for Body.
      return (res.Body as Readable) ?? null;
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async get(bundleId: string): Promise<Buffer | null> {
    const stream = await this.openReadStream(bundleId);
    return stream ? streamToBuffer(stream) : null;
  }
}
