/**
 * Per-install request signing. After enrollment the client holds an HMAC secret; every
 * request carries `installId`, a fresh `nonce`, a `timestamp`, and an HMAC `signature` over
 * a canonical string. The backend recomputes the HMAC with that install's secret and rejects
 * mismatches, stale timestamps, and replayed nonces. Both sides MUST build the canonical
 * string identically — hence this shared helper.
 *
 * This binds requests to an enrolled install and blocks endpoint abuse; the client's bundle
 * **integrity** guarantee is the Ed25519 manifest signature, not this.
 *
 * @module request
 */

import { constantTimeEqualHex, ecdsaP256VerifyB64, hmacSha256Hex } from './crypto.js';

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
 * Compute the request signature.
 * @param secretB64 the per-install HMAC secret (base64)
 * @param p the request parts
 * @returns hex HMAC-SHA256
 */
export function signRequest(secretB64: string, p: SignedRequestParts): string {
  return hmacSha256Hex(secretB64, requestSigningString(p));
}

/**
 * Verify a request signature in constant time.
 * @param secretB64 the per-install HMAC secret (base64)
 * @param p the request parts
 * @param signatureHex the signature presented by the client
 * @returns true if valid
 */
export function verifyRequestSignature(secretB64: string, p: SignedRequestParts, signatureHex: string): boolean {
  return constantTimeEqualHex(signRequest(secretB64, p), signatureHex);
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
