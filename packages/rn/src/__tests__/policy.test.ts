import { describe, expect, it } from '@jest/globals';
import { isStoreUrl, resolvePolicy } from '../policy';
import type { NativeVersionPolicy, OtaLogger } from '../types';

/** Collects what the provider would have logged, so the warnings can be asserted on. */
function recordingLogger(): OtaLogger & { warns: string[]; errors: string[] } {
  const warns: string[] = [];
  const errors: string[] = [];
  return {
    warns,
    errors,
    info: () => {},
    warn: (m: string) => warns.push(m),
    error: (m: string) => errors.push(m),
  };
}

const hard = (storeUrl?: string): NativeVersionPolicy => ({
  minSupportedNativeVersion: 42,
  severity: 'hard',
  ...(storeUrl === undefined ? {} : { storeUrl }),
});

describe('force-update policy is not signed, so its storeUrl is never trusted', () => {
  it('drops whatever the server sent, even a plausible https link', () => {
    const logger = recordingLogger();
    const out = resolvePolicy(hard('https://play.google.com/store/apps/details?id=com.real'), undefined, logger);

    expect(out.storeUrl).toBeUndefined();
    expect(out.severity).toBe('hard');
    expect(out.minSupportedNativeVersion).toBe(42);
    expect(logger.warns.join(' ')).toMatch(/not signed/);
  });

  it('drops an outright hostile one without opening it', () => {
    const logger = recordingLogger();
    for (const hostile of ['https://attacker.example/pay', 'javascript:alert(1)', 'data:text/html,x']) {
      expect(resolvePolicy(hard(hostile), undefined, logger).storeUrl).toBeUndefined();
    }
  });

  it('uses the URL the app was built with instead', () => {
    const logger = recordingLogger();
    const mine = 'market://details?id=com.your.app';
    const out = resolvePolicy(hard('https://attacker.example'), mine, logger);

    expect(out.storeUrl).toBe(mine);
    expect(logger.warns).toHaveLength(0);
  });

  it('refuses a misconfigured app URL rather than opening it', () => {
    const logger = recordingLogger();
    const out = resolvePolicy(hard(), 'ftp://nope', logger);

    expect(out.storeUrl).toBeUndefined();
    expect(logger.errors.join(' ')).toMatch(/must start with/);
  });

  it('stays quiet when the server sent nothing and nothing is configured', () => {
    const logger = recordingLogger();
    const out = resolvePolicy(hard(), undefined, logger);

    expect(out.storeUrl).toBeUndefined();
    expect(logger.warns).toHaveLength(0);
    expect(logger.errors).toHaveLength(0);
  });

  it('accepts the three store schemes and nothing else', () => {
    expect(isStoreUrl('https://apps.apple.com/app/id1')).toBe(true);
    expect(isStoreUrl('market://details?id=a')).toBe(true);
    expect(isStoreUrl('itms-apps://itunes.apple.com/app/id1')).toBe(true);
    expect(isStoreUrl('http://insecure')).toBe(false);
    expect(isStoreUrl('javascript:alert(1)')).toBe(false);
    expect(isStoreUrl(undefined)).toBe(false);
  });
});
