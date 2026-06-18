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

export type Platform = 'ios' | 'android';
export type Channel = 'dev' | 'uat' | 'prod';

/** One file in the OTA payload (the JS/HBC bundle or an asset), with its integrity hash. */
export interface FileEntry {
  /** path relative to the bundle root, e.g. "index.android.bundle" or "assets/img/x.png". */
  path: string;
  /** lowercase hex SHA-256 of the file's **plaintext** bytes. */
  sha256: string;
  /** plaintext size in bytes. */
  size: number;
}

/** AES-256-GCM parameters for decrypting the payload archive. */
export interface ManifestEncryption {
  algo: 'AES-256-GCM';
  /** base64 IV. */
  ivB64: string;
  /** base64 GCM auth tag. */
  tagB64: string;
  /**
   * base64 AES-256 content key. NOTE: in v1 this rides the (TLS) `/check` response, so it is
   * confidential against passive sniffing but not an active MITM until the pinning plug-in
   * lands. Integrity never depends on it (that's the Ed25519 signature).
   */
  contentKeyB64: string;
  /** lowercase hex SHA-256 of the **ciphertext** archive, so the download can be verified before decrypt. */
  ciphertextSha256: string;
  /** ciphertext size in bytes (for the download progress + disk pre-check). */
  ciphertextSize: number;
}

/** The signed payload. Bump `schema` on any breaking shape change. */
export interface Manifest {
  schema: 1;
  /** globally-unique id for this bundle/release. */
  bundleId: string;
  /** native-compatibility key — an OTA is only eligible for a binary with the same value. */
  runtimeVersion: string;
  /** monotonic counter within a runtimeVersion (downgrade guard). */
  bundleVersion: number;
  platform: Platform;
  channel: Channel;
  /** ISO-8601 creation time. */
  createdAt: string;
  /** whether the client must apply before continuing. */
  mandatory: boolean;
  /** optional: minimum native build number that may run this (force-update hint). */
  minNativeBuild?: number;
  /** optional: semver range over the app marketing/build version, e.g. ">=1.2.0 <1.3.0". */
  targetAppVersions?: string;
  /** every file in the decrypted payload, with per-file hashes (verified natively). */
  files: FileEntry[];
  encryption: ManifestEncryption;
  /** optional human release notes (shown as in-app "What's New"). */
  releaseNotes?: string;
  /** id of the signing key, so the client can pick the right key from its key ring. */
  keyId: string;
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
 * Lightweight runtime shape validation for the trust boundary (backend ingest + native).
 * Returns a list of problems; empty means structurally valid. Not a substitute for the
 * signature check — it just rejects malformed input early.
 * @param value untrusted parsed JSON
 * @returns array of human-readable validation errors (empty if valid)
 */
export function validateManifestShape(value: unknown): string[] {
  const errors: string[] = [];
  const m = value as Partial<Manifest> | null;
  if (!m || typeof m !== 'object') return ['manifest is not an object'];
  if (m.schema !== 1) errors.push('schema must be 1');
  if (!m.bundleId) errors.push('bundleId is required');
  if (!m.runtimeVersion) errors.push('runtimeVersion is required');
  if (typeof m.bundleVersion !== 'number' || !Number.isInteger(m.bundleVersion)) {
    errors.push('bundleVersion must be an integer');
  }
  if (m.platform !== 'ios' && m.platform !== 'android') errors.push('platform must be ios|android');
  if (m.channel !== 'dev' && m.channel !== 'uat' && m.channel !== 'prod') errors.push('channel must be dev|uat|prod');
  if (typeof m.mandatory !== 'boolean') errors.push('mandatory must be a boolean');
  if (!Array.isArray(m.files) || m.files.length === 0) {
    errors.push('files must be a non-empty array');
  } else {
    m.files.forEach((f, i) => {
      if (!f || typeof f.path !== 'string') errors.push(`files[${i}].path invalid`);
      if (!f || typeof f.sha256 !== 'string' || f.sha256.length !== 64) errors.push(`files[${i}].sha256 invalid`);
      if (!f || typeof f.size !== 'number') errors.push(`files[${i}].size invalid`);
    });
  }
  const e = m.encryption;
  if (!e || e.algo !== 'AES-256-GCM') errors.push('encryption.algo must be AES-256-GCM');
  else {
    if (!e.ivB64) errors.push('encryption.ivB64 required');
    if (!e.tagB64) errors.push('encryption.tagB64 required');
    if (!e.contentKeyB64) errors.push('encryption.contentKeyB64 required');
    if (!e.ciphertextSha256 || e.ciphertextSha256.length !== 64) errors.push('encryption.ciphertextSha256 invalid');
  }
  if (!m.keyId) errors.push('keyId is required');
  return errors;
}
