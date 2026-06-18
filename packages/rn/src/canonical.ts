/**
 * Canonical JSON — byte-identical to `@dash-ota/shared`'s `canonicalize` (and therefore to
 * what the CLI signed). Pure JS (no Node APIs), safe in Hermes. JS produces the canonical
 * manifest bytes; **native** verifies the Ed25519 signature over those exact bytes against the
 * embedded public key — so the integrity guarantee stays in native, while we avoid
 * reimplementing canonicalization in Kotlin/Swift.
 */

function sortValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new Error('canonicalize: non-finite numbers are not allowed');
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(sortValue);
  const input = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(input).sort()) {
    if (input[key] === undefined) continue;
    output[key] = sortValue(input[key]);
  }
  return output;
}

/** Serialize a value to its canonical JSON string (sorted keys, compact). */
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortValue(value));
}
