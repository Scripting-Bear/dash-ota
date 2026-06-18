/**
 * Deterministic ("canonical") JSON serialization used as the exact byte input to signing
 * and verification. Both the CLI (signer) and the native client (verifier) MUST produce
 * identical bytes for the same logical object, or signatures will not match.
 *
 * Rules: object keys sorted ascending (recursively), arrays preserve order, no insignificant
 * whitespace, and non-finite numbers are rejected (they have no portable representation).
 *
 * @module canonical
 */

/**
 * Recursively produce a value with object keys sorted, so `JSON.stringify` is deterministic.
 * @param value any JSON-serializable value
 * @returns the same value with all nested object keys sorted
 * @throws {Error} if a non-finite number is encountered
 */
function sortValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new Error('canonicalize: non-finite numbers are not allowed');
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  const input = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(input).sort()) {
    const child = input[key];
    if (child === undefined) continue; // omit undefined so it round-trips with JSON
    output[key] = sortValue(child);
  }
  return output;
}

/**
 * Serialize a value to its canonical JSON string (sorted keys, compact).
 * @param value the value to canonicalize
 * @returns canonical JSON string
 * @example
 * canonicalize({ b: 1, a: 2 }) // '{"a":2,"b":1}'
 */
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

/**
 * Canonical JSON as UTF-8 bytes — the exact buffer that gets signed/verified.
 * @param value the value to canonicalize
 * @returns UTF-8 Buffer of the canonical JSON
 */
export function canonicalBytes(value: unknown): Buffer {
  return Buffer.from(canonicalize(value), 'utf8');
}
