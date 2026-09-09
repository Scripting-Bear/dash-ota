/**
 * Spooling an uploaded blob to disk.
 *
 * A publish body can be tens of megabytes, so it is never buffered in memory: it is streamed to a
 * temp file while being hashed, and the cap is enforced as the bytes arrive rather than after.
 *
 * @module upload
 */

import { createHash } from 'node:crypto';
import { createWriteStream, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';

/** Thrown when a body exceeds the configured cap. Carries the limit so the route can report it. */
export class BlobTooLargeError extends Error {
  constructor(readonly limit: number) {
    super(`blob exceeds ${limit} bytes`);
    this.name = 'BlobTooLargeError';
  }
}

/** A body written to a temp file, with its measured size and hash. */
export interface SpooledBlob {
  path: string;
  size: number;
  sha256: string;
  /** Remove the temp file. Always call this, in a `finally`. */
  dispose(): void;
}

/**
 * Read a request body to a temp file, hashing as it goes.
 *
 * @param body - the request stream.
 * @param maxBytes - hard cap; exceeding it aborts the read and throws.
 * @returns the spooled file, its size and its SHA-256.
 * @throws {BlobTooLargeError} when the body exceeds `maxBytes`.
 */
export async function spoolToTemp(body: Readable, maxBytes: number): Promise<SpooledBlob> {
  const dir = mkdtempSync(join(tmpdir(), 'dash-ota-'));
  const path = join(dir, 'blob.bin');
  const out = createWriteStream(path);
  const hash = createHash('sha256');
  let size = 0;
  const dispose = (): void => rmSync(dir, { recursive: true, force: true });

  try {
    await new Promise<void>((resolve, reject) => {
      body.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes) {
          // Stop reading immediately rather than draining a hostile body to the end.
          body.destroy();
          out.destroy();
          reject(new BlobTooLargeError(maxBytes));
          return;
        }
        hash.update(chunk);
        if (!out.write(chunk)) {
          body.pause();
          out.once('drain', () => body.resume());
        }
      });
      body.on('error', reject);
      body.on('end', () => out.end(resolve));
      out.on('error', reject);
    });
  } catch (err) {
    dispose();
    throw err;
  }

  return { path, size, sha256: hash.digest('hex'), dispose };
}

/**
 * Consume and discard a body. Needed when a request is answered without reading its payload —
 * leaving it unread wedges keep-alive connections.
 *
 * @param body - the request stream.
 */
export async function drain(body: Readable): Promise<void> {
  await new Promise<void>((resolve) => {
    body.on('data', () => undefined);
    body.on('error', () => resolve());
    body.on('end', resolve);
    body.resume();
  });
}
