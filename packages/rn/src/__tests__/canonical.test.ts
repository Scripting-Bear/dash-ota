/**
 * Canonicalization guard. The client's `canonicalize` MUST be byte-identical to
 * `@dash-ota/shared`'s (which is what the CLI signed) — otherwise the manifest bytes JS hands to
 * native for Ed25519 verification wouldn't match the signature and every update would fail (or,
 * worse, a drift could weaken the check). These vectors pin the exact algorithm: keys sorted,
 * `undefined` dropped, compact separators, non-finite rejected.
 */

import { describe, expect, it } from '@jest/globals';
import { canonicalize } from '../canonical';

describe('canonicalize', () => {
  it('sorts object keys and uses compact separators', () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalize({ a: 2, b: 1 })).toBe('{"a":2,"b":1}');
  });

  it('drops undefined-valued keys', () => {
    expect(canonicalize({ a: undefined, b: 1 })).toBe('{"b":1}');
  });

  it('recurses into nested objects and preserves array order', () => {
    expect(canonicalize({ z: { y: 1, x: 2 }, a: [3, 1, 2] })).toBe('{"a":[3,1,2],"z":{"x":2,"y":1}}');
  });

  it('preserves unicode and primitive types', () => {
    expect(canonicalize({ s: 'héllo', n: 0, t: true, z: null })).toBe('{"n":0,"s":"héllo","t":true,"z":null}');
  });

  it('rejects non-finite numbers (they are not representable in canonical JSON)', () => {
    expect(() => canonicalize({ x: Number.POSITIVE_INFINITY })).toThrow(/non-finite/);
    expect(() => canonicalize({ x: Number.NaN })).toThrow(/non-finite/);
  });

  it('matches a realistic signed-manifest shape byte-for-byte', () => {
    const manifest = {
      schema: 1,
      bundleId: 'bnd_R2_v1',
      runtimeVersion: 'R2',
      bundleVersion: 1,
      platform: 'android',
      channel: 'dev',
      mandatory: false,
      keyId: 'key_dev_1',
    };
    expect(canonicalize(manifest)).toBe(
      '{"bundleId":"bnd_R2_v1","bundleVersion":1,"channel":"dev","keyId":"key_dev_1","mandatory":false,"platform":"android","runtimeVersion":"R2","schema":1}',
    );
  });
});
