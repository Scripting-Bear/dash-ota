import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { useEffect } from 'react';
import { Platform } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

jest.mock('../NativeDashOta', () => ({
  __esModule: true,
  default: {
    getChannel: jest.fn(() => 'dev'),
    getCurrentBundleMeta: jest.fn(),
    downloadAndStage: jest.fn(),
    applyOnNextLaunch: jest.fn(async () => true),
    consumeFailedReport: jest.fn(() => ''),
    consumeAppliedReport: jest.fn(() => ''),
    isBundleDisabled: jest.fn(() => false),
    markHealthy: jest.fn(),
    addListener: jest.fn(),
    removeListeners: jest.fn(),
  },
}));

jest.mock('../otaClient', () => ({
  createClientContext: jest.fn(async () => ({})),
  checkForUpdate: jest.fn(),
  confirm: jest.fn(async () => undefined),
  blobBaseUrl: jest.fn(() => 'https://ota.example.com/ota/v2/releases/x/blobs'),
}));

import DashOta from '../NativeDashOta';
import { DashOtaProvider } from '../DashOtaProvider';
import { useOtaUpdate } from '../useOtaUpdate';
import { checkForUpdate, confirm } from '../otaClient';
import type { OtaConfig } from '../config';
import type { OtaUpdateState } from '../types';

type NativeMock = jest.Mock<(...args: unknown[]) => unknown>;
const native = DashOta as unknown as Record<
  'getCurrentBundleMeta' | 'downloadAndStage' | 'consumeAppliedReport' | 'markHealthy' | 'addListener' | 'removeListeners',
  NativeMock
>;
const check = checkForUpdate as unknown as jest.Mock<(...args: unknown[]) => Promise<unknown>>;
const confirmMock = confirm as unknown as jest.Mock<(...args: unknown[]) => Promise<unknown>>;

const quietLogger = { info: () => {}, warn: () => {}, error: () => {} };
const config: OtaConfig = {
  appVersion: '1.0.0',
  storage: { getItem: async () => null, setItem: async () => {} },
  getEnrollToken: async () => 'token',
  logger: quietLogger,
};

const OTA_BUNDLE = { bundleId: 'bnd_rt1_3_x', bundleVersion: 3, isEmbedded: false, bundleSha256: '' };

function announce(mandatory: boolean) {
  return {
    update: {
      manifest: { bundleId: 'bnd_rt1_4_y', runtimeVersion: 'rt1', bundleVersion: 4, platform: 'ios', channel: 'dev', mandatory },
      signatureB64: 'sig',
    },
    downloadToken: 'dl',
    serverNonce: 'nonce-1',
    nativePolicy: { minSupportedNativeVersion: 0, severity: 'none' },
  };
}

let latest: OtaUpdateState | null = null;
function Probe({ onMount }: { onMount?: (s: OtaUpdateState) => void }) {
  const state = useOtaUpdate();
  latest = state;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => onMount?.(state), []);
  return null;
}

async function mount(onMount?: (s: OtaUpdateState) => void): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <DashOtaProvider config={config}>
        <Probe onMount={onMount} />
      </DashOtaProvider>,
    );
  });
  return renderer;
}

beforeEach(() => {
  latest = null;
  jest.clearAllMocks();
  native.getCurrentBundleMeta.mockImplementation(async () => OTA_BUNDLE);
  native.downloadAndStage.mockImplementation(async () => ({ bundleId: 'bnd_rt1_4_y', bundleVersion: 4 }));
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('DashOtaProvider', () => {
  it('never subscribes to progress on iOS, which does not implement the listener methods', async () => {
    check.mockImplementation(async () => announce(false));
    const r = await mount();
    expect(native.downloadAndStage).toHaveBeenCalledTimes(1);
    expect(native.addListener).not.toHaveBeenCalled();
    expect(latest?.status).toBe('apply-pending');
    await act(async () => r.unmount());
  });

  it('subscribes on Android and removes the listener when the download ends', async () => {
    jest.replaceProperty(Platform, 'OS', 'android');
    check.mockImplementation(async () => announce(false));
    const r = await mount();
    expect(native.addListener).toHaveBeenCalledWith('onDashOtaProgress');
    expect(native.removeListeners).toHaveBeenCalled();
    await act(async () => r.unmount());
  });

  it('stops blocking when a mandatory announcement fails native verification', async () => {
    check.mockImplementation(async () => announce(true));
    native.downloadAndStage.mockImplementation(async () => {
      throw new Error('manifest signature did not verify');
    });
    const r = await mount();
    expect(latest?.status).toBe('error');
    expect(latest?.isMandatory).toBe(false);
    expect(latest?.ui.blocking).toBe(false);
    await act(async () => r.unmount());
  });

  it('keeps blocking once a verified mandatory bundle is staged', async () => {
    check.mockImplementation(async () => announce(true));
    const r = await mount();
    expect(latest?.ui.phase).toBe('ready');
    expect(latest?.ui.blocking).toBe(true);
    await act(async () => r.unmount());
  });

  it('sends the healthy report even when markHealthy runs before the first check', async () => {
    check.mockImplementation(async () => ({
      update: null,
      serverNonce: 'nonce-1',
      nativePolicy: { minSupportedNativeVersion: 0, severity: 'none' },
    }));
    const r = await mount((s) => s.markHealthy());
    expect(native.markHealthy).toHaveBeenCalledTimes(1);
    expect(confirmMock).toHaveBeenCalledWith(expect.anything(), OTA_BUNDLE.bundleId, 'healthy', 'nonce-1');
    await act(async () => r.unmount());
  });

  it('holds the healthy report for the next check when the apply report used the nonce', async () => {
    check.mockImplementation(async () => ({
      update: null,
      serverNonce: 'nonce-1',
      nativePolicy: { minSupportedNativeVersion: 0, severity: 'none' },
    }));
    native.consumeAppliedReport.mockImplementationOnce(() => OTA_BUNDLE.bundleId);
    const r = await mount((s) => s.markHealthy());
    const statuses = () => confirmMock.mock.calls.map((c) => c[2]);
    expect(statuses()).toEqual(['applied']);

    check.mockImplementation(async () => ({
      update: null,
      serverNonce: 'nonce-2',
      nativePolicy: { minSupportedNativeVersion: 0, severity: 'none' },
    }));
    await act(async () => latest?.checkNow());
    expect(statuses()).toEqual(['applied', 'healthy']);
    expect(confirmMock).toHaveBeenLastCalledWith(expect.anything(), OTA_BUNDLE.bundleId, 'healthy', 'nonce-2');
    await act(async () => r.unmount());
  });

  it('tolerates a check response without a native policy', async () => {
    check.mockImplementation(async () => ({ update: null, serverNonce: 'n' }));
    const r = await mount();
    expect(latest?.status).toBe('up-to-date');
    expect(latest?.nativePolicy).toBeNull();
    await act(async () => r.unmount());
  });
});
