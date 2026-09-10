/**
 * The OTA **manifest** — the signed source of truth for a release. The CLI builds and
 * Ed25519-signs it; the backend stores and serves it verbatim; the native client verifies
 * the signature against an embedded public key, then verifies every file's SHA-256 before
 * applying. The signature covers the *canonical* bytes of the {@link Manifest} (not the
 * envelope), so `keyId`/`signatureB64` live outside the signed object.
 *
 * @module manifest
 */

import { canonicalBytes } from './canonical.js';
import { type KeyObject, signEd25519, verifyEd25519 } from './crypto.js';
import { validatePath } from './paths.js';

export type Platform = 'ios' | 'android';
export type Channel = 'dev' | 'uat' | 'prod';

/** Current manifest schema. Bumped on any breaking shape change; clients reject anything else. */
export const MANIFEST_SCHEMA = 2;
/** Wire protocol the device speaks. Sent on `/check` so the backend can refuse retired clients. */
export const OTA_PROTOCOL = 2;

/** Lowercase hex SHA-256. */
export const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * @param value - candidate.
 * @returns whether it is a lowercase hex SHA-256 string.
 */
export function isSha256Hex(value: unknown): value is string {
  return typeof value === 'string' && SHA256_HEX.test(value);
}

/** How a blob's stored bytes were produced from the plaintext file. */
export type BlobCompressionName = 'zstd' | 'none';

/**
 * The stored bytes for one file. `sha256` is the hash of exactly what the blob endpoint returns,
 * so a download can be verified before it is decrypted — the device never feeds unverified bytes
 * to the cipher.
 */
export interface BlobEntry {
  /** lowercase hex SHA-256 of the **stored** bytes (after compression and encryption). */
  sha256: string;
  /** stored size in bytes. */
  size: number;
  /** compression applied to the plaintext *before* encryption. */
  compression: BlobCompressionName;
  /** base64 IV — present only when the release is encrypted. */
  ivB64?: string;
  /** base64 GCM auth tag — present only when the release is encrypted. */
  tagB64?: string;
}

/** One file in the release, addressed by the hash of its plaintext. */
export interface FileEntryV2 {
  /** path relative to the bundle root, e.g. "index.android.bundle" or "assets/img/x.png". */
  path: string;
  /** exactly one entry per release carries this: the JS bytecode the runtime loads. */
  role?: 'bundle';
  /** lowercase hex SHA-256 of the file's **plaintext** bytes — the dedup key. */
  sha256: string;
  /** plaintext size in bytes. */
  size: number;
  /** where and how the bytes are stored. */
  blob: BlobEntry;
}

/** A delta frame is a blob like any other, distinguished by its compression. */
export type PatchCompression = 'zstd-patch';

/** The stored bytes of a delta frame. */
export interface PatchBlobEntry extends Omit<BlobEntry, 'compression'> {
  compression: PatchCompression;
}

/** A bytecode delta against one base the device may already hold. */
export interface PatchEntry {
  /** lowercase hex SHA-256 of the **plaintext** bytecode this patch applies to. */
  baseSha256: string;
  blob: PatchBlobEntry;
}

/**
 * Payload encryption. Optional per release: the content key rides inside the signed manifest over
 * TLS, so it protects the payload from a passive observer of the blob store or CDN, not from
 * anyone who can legitimately fetch the manifest. Integrity never depends on it — that is the
 * Ed25519 signature plus the per-blob and per-file hashes.
 */
export type EncryptionV2 = { mode: 'none' } | { mode: 'aes-256-gcm'; contentKeyB64: string };

/** The signed payload. */
export interface ManifestV2 {
  schema: typeof MANIFEST_SCHEMA;
  protocol: typeof OTA_PROTOCOL;
  /** globally-unique id for this bundle/release. */
  bundleId: string;
  /** native-compatibility key — an OTA is only eligible for a binary with the same value. */
  runtimeVersion: string;
  /** monotonic counter within a runtimeVersion (downgrade guard). */
  bundleVersion: number;
  platform: Platform;
  channel: Channel;
  /** package name / bundle identifier this release belongs to, verified natively. */
  appId: string;
  /** ISO-8601 creation time. */
  createdAt: string;
  /** whether the client must apply before continuing. */
  mandatory: boolean;
  /** optional: minimum native build number that may run this (force-update hint). */
  minNativeBuild?: number;
  /** optional: semver range over the app marketing/build version, e.g. ">=1.2.0 <1.3.0". */
  targetAppVersions?: string;
  encryption: EncryptionV2;
  /** every file in the release; the device stages exactly this set and nothing else. */
  files: FileEntryV2[];
  /** bytecode deltas the device may use instead of the full bundle blob. Empty when unused. */
  patches: PatchEntry[];
  /** optional human release notes (shown as in-app "What's New"). */
  releaseNotes?: string;
  /** id of the signing key, so the client can pick the right key from its key ring. */
  keyId: string;
}

/** The manifest shape in force. */
export type Manifest = ManifestV2;

/**
 * Additional authenticated data for one blob's AES-GCM. Binds the ciphertext to the plaintext it
 * claims to be, so a blob cannot be swapped for a different file.
 *
 * It deliberately does **not** bind the release. A blob is shared by every release that contains
 * that file — that sharing is the whole point of a content-addressed store — so a release-scoped
 * AAD would make each copy undecryptable outside the release that produced it. Nothing is lost:
 * which blob belongs to which file is asserted by the signed manifest, and the device verifies the
 * plaintext hash after decrypting regardless.
 *
 * @param fileSha256 - plaintext hash of the file (or, for a patch, of its base).
 * @returns the AAD bytes.
 */
export function blobAad(fileSha256: string): Buffer {
  return Buffer.from(fileSha256, 'utf8');
}

/**
 * @param manifest - a release manifest.
 * @returns the entry for the JS bytecode, or undefined if the release has none.
 */
export function bundleEntry(manifest: ManifestV2): FileEntryV2 | undefined {
  return manifest.files.find((f) => f.role === 'bundle');
}

/**
 * Look up a blob the device is allowed to fetch for this release.
 *
 * @param manifest - a release manifest.
 * @param blobSha256 - the stored-bytes hash from the request.
 * @returns the matching file or patch blob, or undefined when the release does not reference it.
 */
export function findBlobEntry(manifest: ManifestV2, blobSha256: string): BlobEntry | PatchBlobEntry | undefined {
  return (
    manifest.files.find((f) => f.blob.sha256 === blobSha256)?.blob ??
    manifest.patches.find((p) => p.blob.sha256 === blobSha256)?.blob
  );
}

/**
 * @param manifest - a release manifest.
 * @returns every distinct blob hash the release references, files and patches alike.
 */
export function collectBlobShas(manifest: ManifestV2): string[] {
  const seen = new Set<string>();
  for (const f of manifest.files) seen.add(f.blob.sha256);
  for (const p of manifest.patches) seen.add(p.blob.sha256);
  return [...seen];
}

/**
 * @param manifest - a release manifest.
 * @returns total stored bytes, counting each distinct blob once.
 */
export function totalBlobBytes(manifest: ManifestV2): number {
  const seen = new Map<string, number>();
  for (const f of manifest.files) seen.set(f.blob.sha256, f.blob.size);
  for (const p of manifest.patches) seen.set(p.blob.sha256, p.blob.size);
  return [...seen.values()].reduce((sum, n) => sum + n, 0);
}

/** Signed envelope: the manifest plus its detached Ed25519 signature. */
export interface SignedManifest {
  manifest: Manifest;
  /** base64 Ed25519 signature over `canonicalBytes(manifest)`. */
  signatureB64: string;
  /** convenience copy of `manifest.keyId`. */
  keyId: string;
}

/**
 * Sign a manifest, producing the envelope the backend stores and serves.
 * @param manifest the manifest to sign
 * @param privateKeyPem PKCS#8 PEM private key (CLI/CI only)
 * @returns the signed envelope
 */
export function signManifest(manifest: Manifest, privateKeyPem: string): SignedManifest {
  const signature = signEd25519(privateKeyPem, canonicalBytes(manifest));
  return { manifest, signatureB64: signature.toString('base64'), keyId: manifest.keyId };
}

/**
 * Verify a signed manifest against a trusted public key.
 * @param signed the signed envelope
 * @param publicKey PEM string or KeyObject (from the app's embedded key ring)
 * @returns true if the signature is valid for the canonical manifest bytes
 */
export function verifyManifest(signed: SignedManifest, publicKey: string | KeyObject): boolean {
  return verifyEd25519(publicKey, canonicalBytes(signed.manifest), Buffer.from(signed.signatureB64, 'base64'));
}

/**
 * Structural validation of an untrusted manifest, before any signature check. Cheap, total, and
 * deliberately strict: everything the device will act on is checked here so the backend can reject
 * a malformed publish, and so no later code has to re-derive whether a field is sane.
 *
 * @param value - parsed JSON claiming to be a manifest.
 * @returns a list of problems; empty means the shape is valid.
 */
export function validateManifestShape(value: unknown): string[] {
  const errors: string[] = [];
  const m = value as Partial<ManifestV2> | null;
  if (!m || typeof m !== 'object') return ['manifest is not an object'];

  if (m.schema !== MANIFEST_SCHEMA) errors.push(`schema must be ${MANIFEST_SCHEMA}`);
  if (m.protocol !== OTA_PROTOCOL) errors.push(`protocol must be ${OTA_PROTOCOL}`);
  if (!m.bundleId) errors.push('bundleId is required');
  if (!m.runtimeVersion) errors.push('runtimeVersion is required');
  if (typeof m.bundleVersion !== 'number' || !Number.isInteger(m.bundleVersion)) {
    errors.push('bundleVersion must be an integer');
  }
  if (m.platform !== 'ios' && m.platform !== 'android') errors.push('platform must be ios|android');
  if (m.channel !== 'dev' && m.channel !== 'uat' && m.channel !== 'prod') errors.push('channel must be dev|uat|prod');
  if (!m.appId) errors.push('appId is required');
  if (typeof m.mandatory !== 'boolean') errors.push('mandatory must be a boolean');
  if (!m.keyId) errors.push('keyId is required');

  const enc = m.encryption;
  const encrypted = !!enc && enc.mode === 'aes-256-gcm';
  if (!enc || (enc.mode !== 'none' && enc.mode !== 'aes-256-gcm')) {
    errors.push('encryption.mode must be none|aes-256-gcm');
  } else if (enc.mode === 'aes-256-gcm' && !enc.contentKeyB64) {
    errors.push('encryption.contentKeyB64 is required when encrypted');
  }

  // A blob entry is validated the same way whether it backs a file or a patch; only the set of
  // acceptable `compression` values differs.
  const checkBlob = (blob: unknown, label: string, allowed: readonly string[]): void => {
    const b = blob as Partial<BlobEntry> | undefined;
    if (!b || typeof b !== 'object') {
      errors.push(`${label}.blob is missing`);
      return;
    }
    if (!isSha256Hex(b.sha256)) errors.push(`${label}.blob.sha256 invalid`);
    if (typeof b.size !== 'number' || !Number.isInteger(b.size) || b.size < 0) {
      errors.push(`${label}.blob.size invalid`);
    }
    if (typeof b.compression !== 'string' || !allowed.includes(b.compression)) {
      errors.push(`${label}.blob.compression must be one of ${allowed.join('|')}`);
    }
    // The IV and tag are exactly as required as the cipher is: present iff encrypted.
    if (encrypted && !b.ivB64) errors.push(`${label}.blob.ivB64 is required when encrypted`);
    if (encrypted && !b.tagB64) errors.push(`${label}.blob.tagB64 is required when encrypted`);
    if (!encrypted && (b.ivB64 || b.tagB64)) errors.push(`${label}.blob has ivB64/tagB64 but the release is not encrypted`);
  };

  if (!Array.isArray(m.files) || m.files.length === 0) {
    errors.push('files must be a non-empty array');
  } else {
    const paths = new Set<string>();
    let bundles = 0;
    m.files.forEach((f, i) => {
      const label = `files[${i}]`;
      if (!f || typeof f !== 'object') {
        errors.push(`${label} is not an object`);
        return;
      }
      const pathError = validatePath(f.path);
      if (pathError) errors.push(`${label}.path ${pathError}`);
      else if (paths.has(f.path)) errors.push(`${label}.path is a duplicate of an earlier entry`);
      else paths.add(f.path);
      if (!isSha256Hex(f.sha256)) errors.push(`${label}.sha256 invalid`);
      if (typeof f.size !== 'number' || !Number.isInteger(f.size) || f.size < 0) errors.push(`${label}.size invalid`);
      if (f.role !== undefined && f.role !== 'bundle') errors.push(`${label}.role must be "bundle" when present`);
      if (f.role === 'bundle') bundles += 1;
      checkBlob(f.blob, label, ['zstd', 'none']);
    });
    if (bundles !== 1) errors.push(`exactly one file must have role "bundle" (found ${bundles})`);
  }

  if (!Array.isArray(m.patches)) {
    errors.push('patches must be an array (use [] when unused)');
  } else {
    m.patches.forEach((patch, i) => {
      const label = `patches[${i}]`;
      if (!patch || typeof patch !== 'object') {
        errors.push(`${label} is not an object`);
        return;
      }
      if (!isSha256Hex(patch.baseSha256)) errors.push(`${label}.baseSha256 invalid`);
      checkBlob(patch.blob, label, ['zstd-patch']);
    });
  }

  return errors;
}
