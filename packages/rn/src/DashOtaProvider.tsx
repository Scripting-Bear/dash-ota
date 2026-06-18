/**
 * DashOtaProvider — orchestrates the OTA lifecycle and exposes it via {@link useOtaUpdate}.
 * On launch it reads the current bundle, enrolls (once), and (by default) checks → downloads
 * → natively verifies/stages → schedules an apply on next cold start. Everything fails closed:
 * any error leaves the last-known-good/embedded bundle running.
 */

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import DashOta from './NativeDashOta';
import { canonicalize } from './canonical';
import { consoleLogger, type OtaConfig } from './config';
import { checkForUpdate, confirm, createClientContext, downloadUrl, type OtaClientContext } from './otaClient';
import type { AvailableUpdate, BundleMeta, NativeVersionPolicy, OtaStatus, OtaUpdateState } from './types';

const OtaContext = createContext<OtaUpdateState | null>(null);

/** Provider props. */
export interface DashOtaProviderProps {
  config: OtaConfig;
  children: React.ReactNode;
}

/** Wrap the app root to enable OTA. */
export function DashOtaProvider({ config, children }: DashOtaProviderProps): React.ReactElement {
  const logger = config.logger ?? consoleLogger;
  const [status, setStatus] = useState<OtaStatus>('idle');
  const [currentBundle, setCurrentBundle] = useState<BundleMeta | null>(null);
  const [availableUpdate, setAvailableUpdate] = useState<AvailableUpdate | null>(null);
  const [nativePolicy, setNativePolicy] = useState<NativeVersionPolicy | null>(null);
  const [isMandatory, setIsMandatory] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const ctxRef = useRef<OtaClientContext | null>(null);
  const serverNonceRef = useRef<string>('');
  const inFlight = useRef(false);

  const ensureCtx = useCallback(async (): Promise<OtaClientContext> => {
    if (!ctxRef.current) ctxRef.current = await createClientContext(config, logger);
    return ctxRef.current;
  }, [config, logger]);

  const checkNow = useCallback(async (): Promise<void> => {
    if (inFlight.current) return;
    inFlight.current = true;
    setError(null);
    setProgress(0);
    try {
      setStatus('checking');
      const ctx = await ensureCtx();
      const meta = (await DashOta.getCurrentBundleMeta()) as unknown as BundleMeta;
      setCurrentBundle(meta);

      const resp = await checkForUpdate(ctx, meta.bundleVersion, config.appVersion);
      setNativePolicy(resp.nativePolicy);
      serverNonceRef.current = resp.serverNonce;

      // Report a crash-loop failure from a prior launch exactly once (drives server auto-pause).
      const failed = DashOta.consumeFailedReport();
      if (failed) {
        logger.warn(`reporting crash-loop failure of ${failed}`);
        void confirm(ctx, failed, 'failed', resp.serverNonce, 'crash-loop revert').catch(() => undefined);
      }

      if (!resp.update || !resp.downloadToken) {
        setAvailableUpdate(null);
        setStatus('up-to-date');
        return;
      }
      const m = resp.update.manifest;
      setAvailableUpdate({ bundleId: m.bundleId, bundleVersion: m.bundleVersion, mandatory: m.mandatory, releaseNotes: m.releaseNotes });
      setIsMandatory(Boolean(m.mandatory));

      // Don't re-download a bundle the crash-loop breaker already disabled on this device.
      if (DashOta.isBundleDisabled(m.bundleId)) {
        logger.warn(`skipping disabled bundle ${m.bundleId}`);
        setStatus('up-to-date');
        return;
      }

      if (config.autoStage === false) {
        setStatus('up-to-date');
        return;
      }
      setStatus('downloading');
      const staged = (await DashOta.downloadAndStage(
        downloadUrl(ctx),
        resp.downloadToken,
        canonicalize(m), // canonical bytes the CLI signed; native verifies the Ed25519 sig over these
        resp.update.signatureB64
      )) as unknown as { bundleId: string; bundleVersion: number };
      setProgress(1);
      logger.info(`staged ${staged.bundleId} v${staged.bundleVersion}`);
      setStatus('staged');
      await DashOta.applyOnNextLaunch();
      setStatus('apply-pending');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      setStatus('error');
      logger.error(`check/stage failed: ${msg}`);
    } finally {
      inFlight.current = false;
    }
  }, [config, ensureCtx, logger]);

  const applyUpdate = useCallback(async (restart?: boolean): Promise<void> => {
    await DashOta.applyOnNextLaunch();
    setStatus('apply-pending');
    if (restart) DashOta.restart();
  }, []);

  const markHealthy = useCallback((): void => {
    try {
      DashOta.markHealthy();
      const ctx = ctxRef.current;
      if (ctx && currentBundle && !currentBundle.isEmbedded && serverNonceRef.current) {
        void confirm(ctx, currentBundle.bundleId, 'healthy', serverNonceRef.current).catch(() => undefined);
      }
    } catch (e) {
      logger.warn(`markHealthy failed: ${String(e)}`);
    }
  }, [currentBundle, logger]);

  const rollback = useCallback(async (): Promise<void> => {
    await DashOta.rollback();
    const meta = (await DashOta.getCurrentBundleMeta()) as unknown as BundleMeta;
    setCurrentBundle(meta);
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const meta = (await DashOta.getCurrentBundleMeta()) as unknown as BundleMeta;
        setCurrentBundle(meta);
      } catch (e) {
        logger.warn(`getCurrentBundleMeta failed: ${String(e)}`);
      }
      if (config.autoCheckOnLaunch !== false) await checkNow();
    })();
    // run once on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Config-driven: auto-promote to last-known-good after a delay (opt-in; manual is safer).
  useEffect(() => {
    const ms = config.autoMarkHealthyMs;
    if (ms == null) return;
    const timer = setTimeout(() => markHealthy(), ms);
    return () => clearTimeout(timer);
  }, [config.autoMarkHealthyMs, markHealthy]);

  // Config-driven: re-check when the app returns to the foreground.
  useEffect(() => {
    if (!config.checkOnAppForeground) return;
    const sub = AppState.addEventListener('change', (s: AppStateStatus) => {
      if (s === 'active') void checkNow();
    });
    return () => sub.remove();
  }, [config.checkOnAppForeground, checkNow]);

  // Config-driven: surface every lifecycle transition to the host for observability.
  useEffect(() => {
    config.onStatusChange?.(status);
    // fire only on status change, not on config identity changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  const channel = DashOta.getChannel();
  const value = useMemo<OtaUpdateState>(
    () => ({ status, channel, currentBundle, availableUpdate, isMandatory, nativePolicy, progress, error, checkNow, applyUpdate, markHealthy, rollback }),
    [status, channel, currentBundle, availableUpdate, isMandatory, nativePolicy, progress, error, checkNow, applyUpdate, markHealthy, rollback]
  );

  return <OtaContext.Provider value={value}>{children}</OtaContext.Provider>;
}

/** Internal: read the OTA context (throws if used outside the provider). */
export function useOtaContext(): OtaUpdateState {
  const v = useContext(OtaContext);
  if (!v) throw new Error('useOtaUpdate must be used within <DashOtaProvider>');
  return v;
}
