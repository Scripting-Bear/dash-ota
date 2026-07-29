/**
 * Cross-package contract guard. The RN client keeps its own copy of `canonicalize` (so native
 * verification doesn't require reimplementing canonicalization in Kotlin/Swift), which risks
 * drifting from `@dash-ota/shared`'s — the copy the CLI actually signs with. This imports shared's
 * canonical **source** directly (not the stale built dist) and asserts byte-identical output, so
 * any drift — the failure mode where every OTA update silently stops verifying — fails CI.
 *
 * (The request-signing-string format is pinned in otaClient.test.ts; shared's
 * `requestSigningString` can't be imported here — it transitively pulls in `crypto.js`, which Jest
 * won't resolve — and importing otaClient would trip the native TurboModule lookup.)
 *
 * NOTE: this file is excluded from the package `tsc` (it imports across the package boundary, which
 * violates rootDir); Jest runs it via Babel. The type-checked canonicalization vectors live in
 * canonical.test.ts.
 */

import { describe, expect, it } from '@jest/globals';
import { canonicalize as sharedCanonicalize } from '../../../shared/src/canonical';
import { canonicalize as rnCanonicalize } from '../canonical';

describe('RN ↔ shared canonicalization contract', () => {
  const manifests: unknown[] = [
    { schema: 1, bundleId: 'b', bundleVersion: 2, z: [3, 1, 2], nested: { y: 1, x: 2 }, s: 'héllo' },
    { a: undefined, b: null, c: true, d: 0 },
    {
      files: [
        { path: 'a', size: 1 },
        { path: 'b', size: 2 },
      ],
      keyId: 'k',
      mandatory: false,
    },
  ];

  it('canonicalize matches shared byte-for-byte (no drift between the two copies)', () => {
    for (const m of manifests) {
      expect(rnCanonicalize(m)).toBe(sharedCanonicalize(m));
    }
  });
});
