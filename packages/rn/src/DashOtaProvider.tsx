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

/**
 * Wrap your app root to enable OTA. On launch it reads the current bundle, enrolls the hardware
 * device key (once), and — by default — checks → downloads → natively verifies/stages → schedules
 * an apply on next cold start. Everything fails closed: any error leaves the last-known-good /
 * embedded bundle running. State + actions are exposed via {@link useOtaUpdate}.
 *
 * @param props `config` ({@link OtaConfig}) + your app's `children`.
 *
 * @example
 * ```tsx
 * import { DashOtaProvider } from 'react-native-dash-ota';
 *
 * export default function Root() {
 *   return (
 *     <DashOtaProvider
 *       config={{
 *         appVersion: '1.4.0',
 *         storage,                                     // AsyncStorage / MMKV / secure-storage adapter
 *         getEnrollToken: () => auth.getSessionToken(), // ties the device key to a real user
 *         checkOnAppForeground: true,
 *       }}
 *     >
 *       <App />
 *     </DashOtaProvider>
 *   );
 * }
 * ```
 */
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
  /**
   * What a deferred download needs: the one-time token plus the exact signed bytes native verifies.
   * Held only until staged (or until the next check replaces it) so `downloadUpdate()` can run long
   * after the check that announced the update.
   */
  const pendingDownload = useRef<{ downloadToken: string; manifestJson: string; signatureB64: string } | null>(null);

  const ensureCtx = useCallback(async (): Promise<OtaClientContext> => {
    if (!ctxRef.current) ctxRef.current = await createClientContext(config, logger);
    return ctxRef.current;
  }, [config, logger]);

  /**
   * Download → native verify/decrypt → stage → arm for next launch, using whatever the last check
   * retained. Shared by the auto-stage path and the explicit {@link downloadUpdate}.
   *
   * @returns true when a bundle ended up staged and pending.
   */
  const stagePendingDownload = useCallback(async (): Promise<boolean> => {
    const material = pendingDownload.current;
    const ctx = ctxRef.current;
    if (!material || !ctx) return false;
    setStatus('downloading');
    const staged = (await DashOta.downloadAndStage(
      downloadUrl(ctx),
      material.downloadToken,
      material.manifestJson,
      material.signatureB64,
    )) as unknown as { bundleId: string; bundleVersion: number };
    // The download token is one-time — drop it so a retry re-checks instead of replaying a dead token.
    pendingDownload.current = null;
    setProgress(1);
    logger.info(`staged ${staged.bundleId} v${staged.bundleVersion}`);
    setStatus('staged');
    await DashOta.applyOnNextLaunch();
    setStatus('apply-pending');
    return true;
  }, [logger]);

  const downloadUpdate = useCallback(async (): Promise<boolean> => {
    if (config.enabled === false) return false;
    if (inFlight.current) return false;
    if (!pendingDownload.current) {
      logger.warn('downloadUpdate: nothing announced to download — run checkNow() first');
      return false;
    }
    inFlight.current = true;
    setError(null);
    setProgress(0);
    try {
      return await stagePendingDownload();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      setStatus('error');
      logger.error(`downloadUpdate failed: ${msg}`);
      return false;
    } finally {
      inFlight.current = false;
    }
  }, [config.enabled, logger, stagePendingDownload]);

  const checkNow = useCallback(async (): Promise<void> => {
    if (config.enabled === false) {
      setStatus('disabled');
      return;
    }
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
      setAvailableUpdate({
        bundleId: m.bundleId,
        bundleVersion: m.bundleVersion,
        mandatory: m.mandatory,
        releaseNotes: m.releaseNotes,
      });
      setIsMandatory(Boolean(m.mandatory));

      // Don't re-download a bundle the crash-loop breaker already disabled on this device.
      if (DashOta.isBundleDisabled(m.bundleId)) {
        logger.warn(`skipping disabled bundle ${m.bundleId}`);
        setStatus('up-to-date');
        return;
      }

      // Keep what a later download needs; canonicalize once, here, while the response is in hand.
      pendingDownload.current = {
        downloadToken: resp.downloadToken,
        manifestJson: canonicalize(m), // canonical bytes the CLI signed; native verifies the Ed25519 sig over these
        signatureB64: resp.update.signatureB64,
      };

      // `autoStage: false` hands the bandwidth decision to the host — stop at 'update-available' and
      // let it call downloadUpdate(). A mandatory update is not optional, so it still self-downloads.
      if (config.autoStage === false && !m.mandatory) {
        setStatus('update-available');
        return;
      }
      await stagePendingDownload();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      setStatus('error');
      logger.error(`check/stage failed: ${msg}`);
    } finally {
      inFlight.current = false;
    }
  }, [config, ensureCtx, logger]);

  const applyUpdate = useCallback(
    async (restart?: boolean): Promise<boolean> => {
      if (config.enabled === false) return false; // never apply an OTA bundle on a disabled/untrusted runtime
      // Only claim (and act on) "apply-pending" when a bundle really is pending. `applyOnNextLaunch`
      // promotes `staged` → `pending` and returns false when there is nothing staged — which is the
      // normal case mid-download. Reporting success there made the UI invite a restart that could
      // not apply anything, and restarting mid-download threw the partial download away.
      const promoted = await DashOta.applyOnNextLaunch();
      const pending = promoted || Boolean(((await DashOta.getState()) as { pendingBundleId?: string }).pendingBundleId);
      if (!pending) {
        logger.warn('applyUpdate: nothing staged yet — not restarting');
        return false;
      }
      setStatus('apply-pending');
      if (restart) DashOta.restart();
      return true;
    },
    [config.enabled, logger],
  );

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
      if (config.enabled === false) {
        setStatus('disabled'); // e.g. jailbroken/rooted device — run the store bundle only
        return;
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
    () => ({
      status,
      channel,
      currentBundle,
      availableUpdate,
      isMandatory,
      nativePolicy,
      progress,
      error,
      checkNow,
      downloadUpdate,
      applyUpdate,
      markHealthy,
      rollback,
    }),
    [
      status,
      channel,
      currentBundle,
      availableUpdate,
      isMandatory,
      nativePolicy,
      progress,
      error,
      checkNow,
      downloadUpdate,
      applyUpdate,
      markHealthy,
      rollback,
    ],
  );

  return <OtaContext.Provider value={value}>{children}</OtaContext.Provider>;
}

/** Internal: read the OTA context (throws if used outside the provider). */
export function useOtaContext(): OtaUpdateState {
  const v = useContext(OtaContext);
  if (!v) throw new Error('useOtaUpdate must be used within <DashOtaProvider>');
  return v;
}
