/**
 * Per-request auth. After enrollment the device holds a non-exportable hardware key
 * (ECDSA-P256, AndroidKeyStore / Secure Enclave). Every request carries `installId`, a fresh
 * `nonce`, a `timestamp`, and an ECDSA `signature` over a canonical string; the backend
 * verifies it against the public key registered at enroll and rejects bad signatures, stale
 * timestamps, and replayed nonces. There is **no shared secret**. Both sides MUST build the
 * canonical string identically — hence this shared helper.
 *
 * This binds requests to an enrolled install and blocks endpoint abuse; the client's bundle
 * **integrity** guarantee is the Ed25519 manifest signature, not this.
 *
 * @module request
 */

import { ecdsaP256VerifyB64 } from './crypto.js';

/** The fields covered by a request signature. */
export interface SignedRequestParts {
  method: string;
  /** request path including any query string, e.g. "/ota/v1/check". */
  path: string;
  installId: string;
  nonce: string;
  /** unix epoch milliseconds as a string. */
  timestamp: string;
  /** lowercase hex SHA-256 of the raw request body (empty-string hash for no body). */
  bodySha256: string;
}

/**
 * Build the exact canonical string that gets HMAC'd. Newline-delimited, fixed field order.
 * @param p the request parts
 * @returns canonical signing string
 */
export function requestSigningString(p: SignedRequestParts): string {
  return [p.method.toUpperCase(), p.path, p.installId, p.nonce, p.timestamp, p.bodySha256].join('\n');
}

/**
 * Verify a request signed with the device's hardware key (ECDSA-P256). This is the production
 * auth path: there is no shared secret — the backend checks the signature against the public
 * key registered at enrollment.
 * @param devicePublicKeySpkiB64 the device public key (SPKI-DER, base64)
 * @param p the request parts
 * @param signatureB64 the DER ECDSA signature, base64
 * @returns true if valid
 */
export function verifyRequestEcdsa(devicePublicKeySpkiB64: string, p: SignedRequestParts, signatureB64: string): boolean {
  return ecdsaP256VerifyB64(devicePublicKeySpkiB64, Buffer.from(requestSigningString(p), 'utf8'), signatureB64);
}
