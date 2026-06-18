/**
 * High-level release packaging + opening — the reference implementation of the
 * trust-critical client path. The CLI uses {@link buildRelease} then signs; the RN native
 * client must mirror {@link openRelease} (verify signature → check ciphertext hash → decrypt
 * → unpack → verify every file hash) in Kotlin/Swift. Keeping it here means CLI, backend
 * tests, and the native port all agree on one format.
 *
 * @module release
 */

import { type ArchiveFile, packArchive, unpackArchive } from './archive.js';
import { aesGcmDecrypt, aesGcmEncrypt, type KeyObject, randomAesKey, sha256Hex } from './crypto.js';
import { type Channel, type FileEntry, type Manifest, type Platform, type SignedManifest, verifyManifest } from './manifest.js';

/** Inputs to build (but not yet sign) a release. */
export interface BuildReleaseInput {
  bundleId: string;
  runtimeVersion: string;
  bundleVersion: number;
  platform: Platform;
  channel: Channel;
  mandatory: boolean;
  files: ArchiveFile[];
  keyId: string;
  targetAppVersions?: string;
  minNativeBuild?: number;
  releaseNotes?: string;
}

/** A built (unsigned) release: the manifest plus the encrypted archive. */
export interface BuiltRelease {
  manifest: Manifest;
  ciphertext: Buffer;
  /** the AES content key (also embedded in the manifest); returned for convenience/tests. */
  contentKey: Buffer;
}

/**
 * Pack files → encrypt (AES-256-GCM) → build an unsigned manifest with per-file hashes.
 * Sign the returned `manifest` with the CLI's private key to get a {@link SignedManifest}.
 * @param input the release inputs
 * @returns the unsigned manifest + ciphertext + content key
 */
export function buildRelease(input: BuildReleaseInput): BuiltRelease {
  const archive = packArchive(input.files);
  const contentKey = randomAesKey();
  const enc = aesGcmEncrypt(contentKey, archive);
  const files: FileEntry[] = [...input.files]
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((f) => ({ path: f.path, sha256: sha256Hex(f.data), size: f.data.length }));

  const manifest: Manifest = {
    schema: 1,
    bundleId: input.bundleId,
    runtimeVersion: input.runtimeVersion,
    bundleVersion: input.bundleVersion,
    platform: input.platform,
    channel: input.channel,
    createdAt: new Date().toISOString(),
    mandatory: input.mandatory,
    ...(input.minNativeBuild !== undefined ? { minNativeBuild: input.minNativeBuild } : {}),
    ...(input.targetAppVersions ? { targetAppVersions: input.targetAppVersions } : {}),
    files,
    encryption: {
      algo: 'AES-256-GCM',
      ivB64: enc.ivB64,
      tagB64: enc.tagB64,
      contentKeyB64: contentKey.toString('base64'),
      ciphertextSha256: sha256Hex(enc.ciphertext),
      ciphertextSize: enc.ciphertext.length,
    },
    ...(input.releaseNotes ? { releaseNotes: input.releaseNotes } : {}),
    keyId: input.keyId,
  };
  return { manifest, ciphertext: enc.ciphertext, contentKey };
}

/**
 * Open a downloaded release exactly as the native client must: verify the Ed25519 signature
 * against a **trusted** key, verify the ciphertext hash, decrypt, unpack, and verify every
 * file's hash + size. Throws (fails closed) on any discrepancy.
 * @param signed the signed manifest from /check
 * @param ciphertext the bytes downloaded from /download
 * @param trustedPublicKey a key from the app's embedded key ring (PEM or KeyObject)
 * @returns the verified payload files
 * @throws {Error} on signature/hash/decrypt/structure failure
 */
export function openRelease(signed: SignedManifest, ciphertext: Buffer, trustedPublicKey: string | KeyObject): ArchiveFile[] {
  if (!verifyManifest(signed, trustedPublicKey)) throw new Error('openRelease: manifest signature invalid');
  const m = signed.manifest;
  if (sha256Hex(ciphertext) !== m.encryption.ciphertextSha256) throw new Error('openRelease: ciphertext hash mismatch');

  const key = Buffer.from(m.encryption.contentKeyB64, 'base64');
  const archive = aesGcmDecrypt(key, m.encryption.ivB64, ciphertext, m.encryption.tagB64);
  const files = unpackArchive(archive);

  if (files.length !== m.files.length) throw new Error('openRelease: file count mismatch');
  const byPath = new Map(files.map((f) => [f.path, f]));
  for (const expected of m.files) {
    const file = byPath.get(expected.path);
    if (!file) throw new Error(`openRelease: missing file ${expected.path}`);
    if (file.data.length !== expected.size) throw new Error(`openRelease: size mismatch ${expected.path}`);
    if (sha256Hex(file.data) !== expected.sha256) throw new Error(`openRelease: hash mismatch ${expected.path}`);
  }
  return files;
}
