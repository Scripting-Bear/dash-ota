/**
 * Per-blob compression. Every file in a release is compressed on its own rather than the release
 * being compressed as a whole, so the device can fetch, verify and decompress one file at a time
 * and reuse the ones it already has.
 *
 * zstd is used over gzip because the Hermes bytecode dominates the payload and compresses far
 * better with it (measured on a real 25.8 MB bundle: 7.3 MB with zstd against 9.4 MB with gzip).
 *
 * @module compression
 */

import { compress, decompress } from '@mongodb-js/zstd';

/** How a blob's bytes were produced from the plaintext file. */
export type BlobCompression = 'zstd' | 'none';

/** zstd level for the Hermes bytecode: it is compressed once per release and is most of the payload. */
export const BUNDLE_COMPRESSION_LEVEL = 19;
/** zstd level for everything else: assets are small and mostly incompressible already. */
export const ASSET_COMPRESSION_LEVEL = 3;

/**
 * Formats whose bytes are already compressed. Running zstd over them burns publish time to save
 * nothing, and often costs a few bytes.
 */
const PRECOMPRESSED_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'webp',
  'gif',
  'avif',
  'heic',
  'mp4',
  'm4a',
  'm4v',
  'mov',
  'mp3',
  'aac',
  'ogg',
  'webm',
  'zip',
  'gz',
  'zst',
  'br',
  'xz',
  'bz2',
  'jar',
  'aar',
  'apk',
  'woff',
  'woff2',
]);

/**
 * Whether a path's extension is worth attempting to compress.
 *
 * @param path - release-relative file path.
 * @returns false when the extension names an already-compressed format.
 */
export function isCompressibleExtension(path: string): boolean {
  const dot = path.lastIndexOf('.');
  if (dot === -1 || dot === path.length - 1) return true; // no extension: try it
  return !PRECOMPRESSED_EXTENSIONS.has(path.slice(dot + 1).toLowerCase());
}

/** A blob's bytes plus how they were produced. */
export interface CompressedBlob {
  data: Buffer;
  compression: BlobCompression;
}

/**
 * Compress one file's bytes for storage as a blob.
 *
 * Falls back to the plaintext whenever compression would not pay: an already-compressed format, or
 * a result that saves less than 2% (the device still spends a decompression pass on it, so a
 * rounding-error saving is not worth the risk of one).
 *
 * @param data - the plaintext file bytes.
 * @param path - release-relative path, used only to read the extension.
 * @param level - zstd level.
 * @returns the bytes to store and the `compression` to record in the manifest.
 */
export async function compressForBlob(data: Buffer, path: string, level: number): Promise<CompressedBlob> {
  if (!isCompressibleExtension(path)) return { data, compression: 'none' };
  const compressed = await compress(data, level);
  if (compressed.length >= data.length * 0.98) return { data, compression: 'none' };
  return { data: compressed, compression: 'zstd' };
}

/** zstd frame magic, little-endian. */
const ZSTD_MAGIC = 0xfd2fb528;

/**
 * Read the decompressed size a zstd frame declares in its own header, without decompressing.
 *
 * This is what makes a decompression bomb cheap to refuse: a 12.5 KB frame can declare 400 MB, and
 * reading fourteen bytes is enough to know that before a single byte is allocated.
 *
 * @param data - a complete zstd frame.
 * @returns the declared content size, or null when the frame omits it or is malformed.
 * @see https://github.com/facebook/zstd/blob/dev/doc/zstd_compression_format.md
 */
export function zstdFrameContentSize(data: Buffer): number | null {
  if (data.length < 5 || data.readUInt32LE(0) !== ZSTD_MAGIC) return null;
  const descriptor = data[4] as number;
  const fcsFieldSize = [0, 2, 4, 8][descriptor >> 6] as number;
  const singleSegment = (descriptor >> 5) & 1;
  const dictIdSize = [0, 1, 2, 4][descriptor & 0b11] as number;
  const offset = 5 + (singleSegment ? 0 : 1) + dictIdSize;

  // A zero flag means one byte when single-segment, and no field at all otherwise.
  if (fcsFieldSize === 0) {
    if (!singleSegment || offset >= data.length) return null;
    return data.readUInt8(offset);
  }
  if (offset + fcsFieldSize > data.length) return null;
  if (fcsFieldSize === 2) return data.readUInt16LE(offset) + 256; // the 2-byte form is offset by 256
  if (fcsFieldSize === 4) return data.readUInt32LE(offset);
  const wide = data.readBigUInt64LE(offset);
  return wide > BigInt(Number.MAX_SAFE_INTEGER) ? null : Number(wide);
}

/**
 * Reverse {@link compressForBlob}. The reference implementation of what the native side does.
 *
 * Refuses to decompress unless the frame's own declared size matches the size the signed manifest
 * promises. Without that check a release whose `size` is wrong — a compromised publisher, or simply
 * a bug — exhausts memory instead of failing cleanly, and on device that OOM then feeds the
 * crash-loop breaker and disables a healthy bundle.
 *
 * @param data - the stored blob bytes, after decryption.
 * @param compression - the manifest's `compression` for that blob.
 * @param expectedSize - the plaintext size the manifest declares for this file.
 * @returns the plaintext file bytes.
 * @throws when the frame declares no size, or a size other than `expectedSize`.
 */
export async function decompressBlob(data: Buffer, compression: BlobCompression, expectedSize: number): Promise<Buffer> {
  if (compression !== 'zstd') {
    if (data.length !== expectedSize) {
      throw new Error(`stored blob is ${data.length} bytes, manifest says ${expectedSize}`);
    }
    return data;
  }
  const declared = zstdFrameContentSize(data);
  if (declared === null) {
    throw new Error('zstd frame declares no content size; refusing to decompress an unbounded frame');
  }
  if (declared !== expectedSize) {
    throw new Error(`zstd frame declares ${declared} bytes, manifest says ${expectedSize}`);
  }
  return decompress(data);
}
