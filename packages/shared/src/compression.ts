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
  'png', 'jpg', 'jpeg', 'webp', 'gif', 'avif', 'heic',
  'mp4', 'm4a', 'm4v', 'mov', 'mp3', 'aac', 'ogg', 'webm',
  'zip', 'gz', 'zst', 'br', 'xz', 'bz2', 'jar', 'aar', 'apk',
  'woff', 'woff2',
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

/**
 * Reverse {@link compressForBlob}. The reference implementation of what the native side does.
 *
 * @param data - the stored blob bytes, after decryption.
 * @param compression - the manifest's `compression` for that blob.
 * @returns the plaintext file bytes.
 */
export async function decompressBlob(data: Buffer, compression: BlobCompression): Promise<Buffer> {
  return compression === 'zstd' ? decompress(data) : data;
}
