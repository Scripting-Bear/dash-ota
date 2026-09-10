/**
 * Building and verifying a release.
 *
 * A release is a signed manifest plus one **blob per distinct file**, addressed by the hash of the
 * file's plaintext. That is what makes an update small: the device already knows the hashes it
 * holds, so it fetches only the blobs it is missing and hard-links the rest out of its previous
 * slot. Two identical files anywhere in a release share one blob.
 *
 * {@link verifyReleaseV2} is the reference implementation of what the native client does. The CLI
 * runs it in CI against a real published release, so a change that would break devices fails the
 * build instead of the fleet.
 *
 * @module release
 */

import {
  ASSET_COMPRESSION_LEVEL,
  BUNDLE_COMPRESSION_LEVEL,
  type BlobCompression,
  compressForBlob,
  decompressBlob,
} from './compression.js';
import { aesGcmDecrypt, aesGcmEncrypt, deriveBlobIv, type KeyObject, sha256Hex } from './crypto.js';
import {
  type BlobEntry,
  blobAad,
  type Channel,
  type EncryptionV2,
  type FileEntryV2,
  MANIFEST_SCHEMA,
  type ManifestV2,
  OTA_PROTOCOL,
  type Platform,
  type SignedManifest,
  validateManifestShape,
  verifyManifest,
} from './manifest.js';
import { validatePath } from './paths.js';

/** One file's plaintext, as read from the bundler output. */
export interface ArchiveFile {
  path: string;
  data: Buffer;
}

/** Everything needed to build a release except the signature. */
export interface BuildReleaseV2Input {
  bundleId: string;
  runtimeVersion: string;
  bundleVersion: number;
  platform: Platform;
  channel: Channel;
  /** package name / bundle identifier; the device refuses a manifest for a different app. */
  appId: string;
  mandatory: boolean;
  files: ArchiveFile[];
  /** which of `files` is the JS bytecode the runtime loads. */
  bundlePath: string;
  keyId: string;
  /** default true. Off stores compressed plaintext, still hash-authenticated. */
  encrypt?: boolean;
  /**
   * The 32-byte content key, required when `encrypt` is not false. Hold **one key per channel**
   * and reuse it for every release: encryption is convergent, so a stable key is what lets the
   * blob store keep a single copy of a file that several releases share.
   */
  contentKey?: Buffer;
  bundleCompressionLevel?: number;
  assetCompressionLevel?: number;
  targetAppVersions?: string;
  minNativeBuild?: number;
  releaseNotes?: string;
}

/** The unsigned manifest plus the bytes to upload. */
export interface BuiltReleaseV2 {
  manifest: ManifestV2;
  /** blob sha256 → the exact bytes the blob endpoint must return. */
  blobs: Map<string, Buffer>;
  /** the release's content key, or null when unencrypted. Never persist this outside the manifest. */
  contentKey: Buffer | null;
}

/**
 * Build a release: hash, compress and (optionally) encrypt every distinct file, then assemble the
 * manifest that describes them.
 *
 * @param input - see {@link BuildReleaseV2Input}.
 * @returns the unsigned manifest, the blobs to upload, and the content key.
 * @throws if a path is unsafe, a path repeats, or `bundlePath` is not among the files.
 *
 * @example
 * const built = await buildReleaseV2({ ...meta, files, bundlePath: 'index.android.bundle' });
 * const signed = signManifest(built.manifest, privateKeyPem);
 */
export async function buildReleaseV2(input: BuildReleaseV2Input): Promise<BuiltReleaseV2> {
  if (input.files.length === 0) throw new Error('buildReleaseV2: no files');

  const seenPaths = new Set<string>();
  for (const file of input.files) {
    const pathError = validatePath(file.path);
    if (pathError) throw new Error(`buildReleaseV2: path ${JSON.stringify(file.path)} ${pathError}`);
    if (seenPaths.has(file.path)) throw new Error(`buildReleaseV2: duplicate path ${JSON.stringify(file.path)}`);
    seenPaths.add(file.path);
  }
  if (!seenPaths.has(input.bundlePath)) {
    throw new Error(`buildReleaseV2: bundlePath ${JSON.stringify(input.bundlePath)} is not among the files`);
  }

  const encrypt = input.encrypt !== false;
  if (encrypt && !input.contentKey) {
    throw new Error(
      'buildReleaseV2: encrypted releases need a contentKey. Reuse one key per channel so the blob ' +
        'store can deduplicate across releases; a fresh key per release silently disables that.',
    );
  }
  if (input.contentKey && input.contentKey.length !== 32) {
    throw new Error('buildReleaseV2: contentKey must be 32 bytes');
  }
  const contentKey = encrypt ? (input.contentKey as Buffer) : null;
  const encryption: EncryptionV2 = contentKey
    ? { mode: 'aes-256-gcm', contentKeyB64: contentKey.toString('base64') }
    : { mode: 'none' };

  const blobs = new Map<string, Buffer>();
  // Keyed by plaintext hash: identical files share one blob, so an asset duplicated across
  // densities or a renamed file costs nothing extra.
  const blobByPlaintext = new Map<string, BlobEntry>();

  const entries: FileEntryV2[] = [];
  for (const file of [...input.files].sort((a, b) => a.path.localeCompare(b.path))) {
    const plaintextSha = sha256Hex(file.data);
    const isBundle = file.path === input.bundlePath;

    let blob = blobByPlaintext.get(plaintextSha);
    if (!blob) {
      const level = isBundle
        ? (input.bundleCompressionLevel ?? BUNDLE_COMPRESSION_LEVEL)
        : (input.assetCompressionLevel ?? ASSET_COMPRESSION_LEVEL);
      const compressed = await compressForBlob(file.data, file.path, level);
      const sealed = sealBlob(compressed.data, compressed.compression, contentKey, plaintextSha);
      blob = sealed.entry;
      blobByPlaintext.set(plaintextSha, blob);
      blobs.set(blob.sha256, sealed.stored);
    }

    entries.push({
      path: file.path,
      ...(isBundle ? { role: 'bundle' as const } : {}),
      sha256: plaintextSha,
      size: file.data.length,
      blob,
    });
  }

  const manifest: ManifestV2 = {
    schema: MANIFEST_SCHEMA,
    protocol: OTA_PROTOCOL,
    bundleId: input.bundleId,
    runtimeVersion: input.runtimeVersion,
    bundleVersion: input.bundleVersion,
    platform: input.platform,
    channel: input.channel,
    appId: input.appId,
    createdAt: new Date().toISOString(),
    mandatory: input.mandatory,
    ...(input.minNativeBuild !== undefined ? { minNativeBuild: input.minNativeBuild } : {}),
    ...(input.targetAppVersions ? { targetAppVersions: input.targetAppVersions } : {}),
    encryption,
    files: entries,
    patches: [],
    ...(input.releaseNotes ? { releaseNotes: input.releaseNotes } : {}),
    keyId: input.keyId,
  };

  const problems = validateManifestShape(manifest);
  if (problems.length > 0) throw new Error(`buildReleaseV2: produced an invalid manifest: ${problems.join('; ')}`);

  return { manifest, blobs, contentKey };
}

/**
 * Encrypt (or not) one already-compressed blob.
 *
 * `entry` and `stored` are kept apart on purpose: `entry` is signed into the manifest, `stored` is
 * uploaded. Carrying the bytes on the entry would serialise the whole payload into the manifest.
 */
function sealBlob(
  data: Buffer,
  compression: BlobCompression,
  contentKey: Buffer | null,
  plaintextSha: string,
): { entry: BlobEntry; stored: Buffer } {
  if (!contentKey) {
    return { entry: { sha256: sha256Hex(data), size: data.length, compression }, stored: data };
  }
  // Convergent: nonce from the bytes being sealed, so an unchanged file seals to the same
  // ciphertext in every release and the blob store stores it once.
  const sealed = aesGcmEncrypt(contentKey, data, blobAad(plaintextSha), deriveBlobIv(contentKey, sha256Hex(data)));
  return {
    entry: {
      sha256: sha256Hex(sealed.ciphertext),
      size: sealed.ciphertext.length,
      compression,
      ivB64: sealed.ivB64,
      tagB64: sealed.tagB64,
    },
    stored: sealed.ciphertext,
  };
}

/** Fetches one blob's stored bytes by its hash. */
export type BlobFetcher = (blobSha256: string) => Promise<Buffer>;

/** A release reassembled and fully verified. */
export interface VerifiedReleaseV2 {
  files: ArchiveFile[];
}

/**
 * Reassemble a release exactly as a device would, failing closed at every step.
 *
 * Order matters and mirrors the native client: signature first, then shape, then per-blob hash
 * *before* decryption (so unverified bytes never reach the cipher), then the GCM tag, then the
 * plaintext hash and size.
 *
 * @param signed - the signed manifest from `/check`.
 * @param fetchBlob - returns a blob's stored bytes by hash.
 * @param trustedPublicKey - the key the app embeds.
 * @returns every file in the release, with verified plaintext.
 * @throws on a bad signature, a malformed manifest, or any hash, size or tag mismatch.
 */
export async function verifyReleaseV2(
  signed: SignedManifest,
  fetchBlob: BlobFetcher,
  trustedPublicKey: string | KeyObject,
): Promise<VerifiedReleaseV2> {
  if (!verifyManifest(signed, trustedPublicKey)) throw new Error('manifest signature did not verify');
  const manifest = signed.manifest;
  const problems = validateManifestShape(manifest);
  if (problems.length > 0) throw new Error(`manifest is invalid: ${problems.join('; ')}`);

  const contentKey = manifest.encryption.mode === 'aes-256-gcm' ? Buffer.from(manifest.encryption.contentKeyB64, 'base64') : null;

  // One fetch per distinct blob, so a duplicated file is downloaded once.
  const plaintextCache = new Map<string, Buffer>();
  const files: ArchiveFile[] = [];

  for (const entry of manifest.files) {
    let data = plaintextCache.get(entry.blob.sha256);
    if (!data) {
      const stored = await fetchBlob(entry.blob.sha256);
      if (stored.length !== entry.blob.size) {
        throw new Error(`blob ${entry.blob.sha256}: size ${stored.length} != ${entry.blob.size}`);
      }
      if (sha256Hex(stored) !== entry.blob.sha256) throw new Error(`blob ${entry.blob.sha256}: hash mismatch`);

      const compressed = contentKey
        ? aesGcmDecrypt(contentKey, entry.blob.ivB64 ?? '', stored, entry.blob.tagB64 ?? '', blobAad(entry.sha256))
        : stored;
      // Bounded: the frame must declare exactly the size the signed manifest promises.
      data = await decompressBlob(compressed, entry.blob.compression, entry.size);

      if (data.length !== entry.size) throw new Error(`${entry.path}: size ${data.length} != ${entry.size}`);
      if (sha256Hex(data) !== entry.sha256) throw new Error(`${entry.path}: plaintext hash mismatch`);
      plaintextCache.set(entry.blob.sha256, data);
    }
    files.push({ path: entry.path, data });
  }

  return { files };
}
