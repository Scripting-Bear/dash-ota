/**
 * Crypto primitives for dash-ota, built only on Node's built-in `crypto` (no external
 * crypto deps, so the trust base is small and auditable).
 *
 * - **Ed25519** for manifest signing/verification (the integrity guarantee).
 * - **AES-256-GCM** for bundle payload confidentiality (defense-in-depth).
 * - **SHA-256** for per-file integrity hashes.
 * - **HMAC-SHA256** for per-install request signing (anti-abuse / anti-replay binding).
 *
 * The native RN client re-implements the *verify* and *decrypt* halves with CryptoKit
 * (iOS) and Tink/BouncyCastle (Android); this module is the canonical reference and is used
 * by the CLI (sign/encrypt) and backend (serve).
 *
 * @module crypto
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
  randomBytes,
  sign as nodeSign,
  timingSafeEqual,
  verify as nodeVerify,
} from 'node:crypto';

export type { KeyObject } from 'node:crypto';

/** An Ed25519 signing keypair, exported in the forms each consumer needs. */
export interface SigningKeyPair {
  /** PKCS#8 PEM private key — CLI/CI only, NEVER ship to the app or backend. */
  privateKeyPem: string;
  /** SPKI PEM public key — convenient for Node verification. */
  publicKeyPem: string;
  /** Raw 32-byte Ed25519 public key, base64 — the form embedded in the app binary. */
  publicKeyRawB64: string;
}

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/**
 * Generate a fresh Ed25519 signing keypair.
 * @returns the keypair in PEM (private/public) and raw-base64 (public) forms
 */
export function generateSigningKeyPair(): SigningKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    publicKeyRawB64: rawPublicKeyB64(publicKey),
  };
}

/**
 * Extract the raw 32-byte Ed25519 public key (base64) from a Node KeyObject.
 * @param publicKey an Ed25519 public KeyObject
 * @returns base64 of the raw 32-byte key
 * @throws {Error} if the key is not Ed25519
 */
export function rawPublicKeyB64(publicKey: KeyObject): string {
  const jwk = publicKey.export({ format: 'jwk' }) as { kty?: string; crv?: string; x?: string };
  if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || !jwk.x) {
    throw new Error('rawPublicKeyB64: not an Ed25519 public key');
  }
  return Buffer.from(jwk.x, 'base64url').toString('base64');
}

/**
 * Reconstruct a verifiable public KeyObject from the raw 32-byte key the app embeds.
 * Lets us prove the embedded key verifies signatures exactly as the native side will.
 * @param rawB64 base64 of the raw 32-byte Ed25519 public key
 * @returns a public KeyObject usable with {@link verifyEd25519}
 */
export function publicKeyFromRawB64(rawB64: string): KeyObject {
  const raw = Buffer.from(rawB64, 'base64');
  if (raw.length !== 32) throw new Error('publicKeyFromRawB64: expected 32 bytes');
  const der = Buffer.concat([ED25519_SPKI_PREFIX, raw]);
  return createPublicKey({ key: der, format: 'der', type: 'spki' });
}

/**
 * Sign bytes with an Ed25519 private key.
 * @param privateKeyPem PKCS#8 PEM private key
 * @param data bytes to sign (typically canonical manifest bytes)
 * @returns the 64-byte signature
 */
export function signEd25519(privateKeyPem: string, data: Buffer): Buffer {
  return nodeSign(null, data, createPrivateKey(privateKeyPem));
}

/**
 * Verify an Ed25519 signature.
 * @param publicKey PEM string or KeyObject of the public key
 * @param data the bytes that were signed
 * @param signature the signature to check
 * @returns true if valid
 */
export function verifyEd25519(publicKey: string | KeyObject, data: Buffer, signature: Buffer): boolean {
  const key = typeof publicKey === 'string' ? createPublicKey(publicKey) : publicKey;
  return nodeVerify(null, data, key, signature);
}

/** AES-256-GCM ciphertext + the parameters needed to decrypt it. */
export interface AesGcmResult {
  /** base64 of the 12-byte IV/nonce. */
  ivB64: string;
  /** the ciphertext bytes. */
  ciphertext: Buffer;
  /** base64 of the 16-byte GCM auth tag. */
  tagB64: string;
}

/**
 * Encrypt a payload with AES-256-GCM and a fresh random IV.
 * @param key 32-byte content key
 * @param plaintext bytes to encrypt
 * @returns iv, ciphertext, and auth tag
 */
export function aesGcmEncrypt(key: Buffer, plaintext: Buffer): AesGcmResult {
  if (key.length !== 32) throw new Error('aesGcmEncrypt: key must be 32 bytes');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { ivB64: iv.toString('base64'), ciphertext, tagB64: cipher.getAuthTag().toString('base64') };
}

/**
 * Decrypt AES-256-GCM ciphertext; throws if the tag does not authenticate (tamper/wrong key).
 * @param key 32-byte content key
 * @param ivB64 base64 IV from {@link AesGcmResult}
 * @param ciphertext the ciphertext bytes
 * @param tagB64 base64 auth tag from {@link AesGcmResult}
 * @returns the recovered plaintext
 * @throws {Error} if authentication fails
 */
export function aesGcmDecrypt(key: Buffer, ivB64: string, ciphertext: Buffer, tagB64: string): Buffer {
  if (key.length !== 32) throw new Error('aesGcmDecrypt: key must be 32 bytes');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/**
 * SHA-256 of a buffer as lowercase hex.
 * @param buf bytes to hash
 * @returns hex digest
 */
export function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * HMAC-SHA256 over a string with a base64 key, as hex. Used for per-install request signing.
 * @param keyB64 base64-encoded HMAC key
 * @param data the canonical request string
 * @returns hex digest
 */
export function hmacSha256Hex(keyB64: string, data: string): string {
  return createHmac('sha256', Buffer.from(keyB64, 'base64')).update(data, 'utf8').digest('hex');
}

/**
 * Constant-time comparison of two hex strings (avoids timing oracles on HMAC/hash checks).
 * @param a hex string
 * @param b hex string
 * @returns true if equal
 */
export function constantTimeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  if (ab.length !== bb.length || ab.length === 0) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Verify an ECDSA-P256-SHA256 signature made by a device's hardware key.
 * @param publicKeySpkiB64 the device public key as SPKI-DER, base64 (stored at enroll)
 * @param message the signed bytes (the canonical request string)
 * @param signatureB64 the DER signature, base64
 * @returns true if valid (false on any malformed input)
 */
export function ecdsaP256VerifyB64(publicKeySpkiB64: string, message: Buffer, signatureB64: string): boolean {
  try {
    const key = createPublicKey({ key: Buffer.from(publicKeySpkiB64, 'base64'), format: 'der', type: 'spki' });
    return nodeVerify('sha256', message, key, Buffer.from(signatureB64, 'base64'));
  } catch {
    return false;
  }
}

/** Random 32-byte AES content key. */
export function randomAesKey(): Buffer {
  return randomBytes(32);
}

/**
 * Random nonce as base64 (server-issued challenge / per-request nonce).
 * @param bytes nonce length in bytes (default 18 → 24 b64 chars)
 */
export function randomNonceB64(bytes = 18): string {
  return randomBytes(bytes).toString('base64');
}

/**
 * Random high-entropy secret as base64 (per-install HMAC secret, download tokens).
 * @param bytes secret length in bytes (default 32)
 */
export function randomSecretB64(bytes = 32): string {
  return randomBytes(bytes).toString('base64');
}
