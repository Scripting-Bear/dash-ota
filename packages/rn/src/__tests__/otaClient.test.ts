/**
 * otaClient unit tests (native module mocked). Covers the request-signing string format (the
 * CLI↔native contract), the CSPRNG-nonce-with-fallback behaviour, and that attestation is actually
 * attached at enrollment (it used to be dead config).
 */

import { describe, expect, it, jest } from '@jest/globals';

jest.mock('../NativeDashOta', () => ({
  __esModule: true,
  default: {
    getServerUrl: jest.fn(() => 'https://ota.example.com'),
    getChannel: jest.fn(() => 'dev'),
    getRuntimeVersion: jest.fn(() => 'R2'),
    getNativeBuildNumber: jest.fn(() => 10),
    getDevicePublicKeyB64: jest.fn(() => 'PUBKEY'),
    isDeviceKeyHardwareBacked: jest.fn(() => true),
    generateNonce: jest.fn(() => 'NATIVE_NONCE'),
    sha256Hex: jest.fn(() => 'BODYHASH'),
    signWithDeviceKey: jest.fn(() => 'SIG'),
  },
}));

import DashOta from '../NativeDashOta';
import { checkForUpdate, createClientContext, makeNonce, type OtaClientContext, signingString } from '../otaClient';
import type { OtaConfig } from '../config';
import type { OtaLogger } from '../types';

const noopLogger: OtaLogger = { info: () => {}, warn: () => {}, error: () => {} };

function memoryStorage() {
  const m = new Map<string, string>();
  return {
    getItem: async (k: string) => m.get(k) ?? null,
    setItem: async (k: string, v: string) => void m.set(k, v),
  };
}

function ctxWith(fetchImpl: typeof fetch): OtaClientContext {
  return {
    serverUrl: 'https://ota.example.com',
    channel: 'dev',
    runtimeVersion: 'R2',
    buildNumber: 10,
    installId: 'inst',
    fetchImpl,
    logger: noopLogger,
  };
}

describe('signingString', () => {
  it('matches the METHOD\\npath\\ninstallId\\nnonce\\ntimestamp\\nbodySha256 contract', () => {
    expect(signingString('post', '/ota/v1/check', 'inst', 'n1', '123', 'abc')).toBe('POST\n/ota/v1/check\ninst\nn1\n123\nabc');
  });
});

describe('makeNonce', () => {
  it('prefers the native CSPRNG nonce', () => {
    jest.mocked(DashOta.generateNonce).mockReturnValueOnce('NATIVE_NONCE');
    expect(makeNonce()).toBe('NATIVE_NONCE');
  });

  it('falls back to a unique JS nonce when native is unavailable', () => {
    jest.mocked(DashOta.generateNonce).mockImplementation(() => {
      throw new Error('not implemented on this binary');
    });
    const a = makeNonce();
    const b = makeNonce();
    expect(a).not.toBe(b);
    expect(a).toMatch(/-/);
    jest.mocked(DashOta.generateNonce).mockReturnValue('NATIVE_NONCE'); // restore
  });
});

describe('createClientContext', () => {
  it('attaches the attestation token at enrollment', async () => {
    let sentBody: Record<string, unknown> = {};
    const fetchImpl = jest.fn(async (_url: string, init: { body: string }) => {
      sentBody = JSON.parse(init.body) as Record<string, unknown>;
      return { ok: true } as Response;
    });
    const config: OtaConfig = {
      storage: memoryStorage(),
      appVersion: '1.2.0',
      transport: { fetch: fetchImpl as unknown as typeof fetch },
      attestor: { getAttestationToken: async () => 'attest-123' },
    };
    await createClientContext(config, noopLogger);
    expect(fetchImpl).toHaveBeenCalledWith('https://ota.example.com/ota/v1/enroll', expect.objectContaining({ method: 'POST' }));
    expect(sentBody.attestationToken).toBe('attest-123');
    expect(sentBody.devicePublicKeyB64).toBe('PUBKEY');
    expect(sentBody.keyHardwareBacked).toBe(true);
    expect(typeof sentBody.installId).toBe('string');
  });

  it('omits the attestation token when no attestor is configured', async () => {
    let sentBody: Record<string, unknown> = {};
    const fetchImpl = jest.fn(async (_url: string, init: { body: string }) => {
      sentBody = JSON.parse(init.body) as Record<string, unknown>;
      return { ok: true } as Response;
    });
    const config: OtaConfig = {
      storage: memoryStorage(),
      appVersion: '1.2.0',
      transport: { fetch: fetchImpl as unknown as typeof fetch },
    };
    await createClientContext(config, noopLogger);
    expect(sentBody.attestationToken).toBeUndefined();
  });

  it('persists and reuses the install id across enrollments', async () => {
    const storage = memoryStorage();
    const fetchImpl = jest.fn(async () => ({ ok: true }) as Response);
    const config: OtaConfig = { storage, appVersion: '1.2.0', transport: { fetch: fetchImpl as unknown as typeof fetch } };
    const c1 = await createClientContext(config, noopLogger);
    const c2 = await createClientContext(config, noopLogger);
    expect(c1.installId).toBe(c2.installId);
  });

  it('throws when enrollment fails', async () => {
    const fetchImpl = jest.fn(async () => ({ ok: false, status: 500 }) as Response);
    const config: OtaConfig = {
      storage: memoryStorage(),
      appVersion: '1.2.0',
      transport: { fetch: fetchImpl as unknown as typeof fetch },
    };
    await expect(createClientContext(config, noopLogger)).rejects.toThrow(/enroll failed/);
  });
});

describe('checkForUpdate (signed request path)', () => {
  it('sends the device-key signature headers and signs the canonical string', async () => {
    jest.mocked(DashOta.generateNonce).mockReturnValue('NNONCE');
    let sentHeaders: Record<string, string> = {};
    let sentBody = '';
    const fetchImpl = jest.fn(async (_url: string, init: { headers: Record<string, string>; body: string }) => {
      sentHeaders = init.headers;
      sentBody = init.body;
      return { ok: true, json: async () => ({ update: null, serverNonce: 's' }) } as unknown as Response;
    });
    await checkForUpdate(ctxWith(fetchImpl as unknown as typeof fetch), 0, '1.2.0');

    expect(sentHeaders['x-ota-install']).toBe('inst');
    expect(sentHeaders['x-ota-nonce']).toBe('NNONCE');
    expect(sentHeaders['x-ota-signature']).toBe('SIG');
    expect(typeof sentHeaders['x-ota-timestamp']).toBe('string');
    // The signature is over the exact canonical string, with the native body hash.
    expect(jest.mocked(DashOta.signWithDeviceKey)).toHaveBeenCalledWith(
      expect.stringMatching(/^POST\n\/ota\/v1\/check\ninst\nNNONCE\n\d+\nBODYHASH$/),
    );
    const body = JSON.parse(sentBody) as { runtimeVersion: string; currentBundleVersion: number };
    expect(body.runtimeVersion).toBe('R2');
    expect(body.currentBundleVersion).toBe(0);
  });

  it('throws on a non-ok response', async () => {
    const fetchImpl = jest.fn(async () => ({ ok: false, status: 401 }) as Response);
    await expect(checkForUpdate(ctxWith(fetchImpl as unknown as typeof fetch), 0, '1.2.0')).rejects.toThrow(/401/);
  });
});
