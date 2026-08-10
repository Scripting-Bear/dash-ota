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
import { consoleLogger, DEFAULT_UI_COPY, type OtaConfig } from './config';
import { checkForUpdate, confirm, createClientContext, downloadUrl, type OtaClientContext } from './otaClient';
import type { AvailableUpdate, BundleMeta, NativeVersionPolicy, OtaPhase, OtaStatus, OtaUi, OtaUpdateState } from './types';

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
  /**
   * A bundle is staged and armed for the next launch. Sticky for the life of the process (only a
   * restart clears it), so a background→foreground re-check can't downgrade a "Restart now" UI back
   * to "Download" while the pending bundle is still sitting there waiting.
   */
  const [isPending, setIsPending] = useState(false);
  /** a UI-driven action is running — keeps {@link OtaUi.action} single-entry against double taps. */
  const [isActing, setIsActing] = useState(false);

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
    await DashOta.applyOnNextLaunch();
    setIsPending(true);
    setStatus('apply-pending');
    return true;
  }, [logger]);

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
      // let it call downloadUpdate(). A mandatory update is not optional, so by default it still
      // self-downloads (`mandatory: 'announce'` opts out and treats it like any other update).
      const forcesDownload = m.mandatory && (config.mandatory ?? 'auto-download') === 'auto-download';
      if (config.autoStage === false && !forcesDownload) {
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

  const downloadUpdate = useCallback(async (): Promise<boolean> => {
    if (config.enabled === false) return false;
    if (inFlight.current) return false;
    if (!pendingDownload.current) {
      logger.warn('downloadUpdate: nothing announced to download — run checkNow() first');
      return false;
    }
    setError(null);
    setProgress(0);
    // Two attempts: the download token is one-time and short-lived, so a user who taps Download some
    // minutes after the announcement gets rejected by the server. That is recoverable without
    // bothering them — re-check once for fresh material and download that instead of erroring out.
    for (let attempt = 0; attempt < 2; attempt++) {
      inFlight.current = true;
      try {
        const staged = await stagePendingDownload();
        inFlight.current = false;
        return staged;
      } catch (e) {
        inFlight.current = false;
        const msg = e instanceof Error ? e.message : String(e);
        const isStaleMaterial = /\b(401|403|404|410)\b/.test(msg);
        if (attempt === 0 && isStaleMaterial) {
          logger.warn(`download rejected (${msg}) — re-checking for fresh material`);
          await checkNow();
          // A mandatory release re-downloads inside checkNow(), leaving nothing to retry here.
          if (pendingDownload.current) continue;
          return false;
        }
        setError(msg);
        setStatus('error');
        logger.error(`downloadUpdate failed: ${msg}`);
        return false;
      }
    }
    return false;
  }, [config.enabled, logger, stagePendingDownload, checkNow]);

  const applyUpdate = useCallback(
    async (restart?: boolean): Promise<boolean> => {
      if (config.enabled === false) return false; // never apply an OTA bundle on a disabled/untrusted runtime
      // Only claim (and act on) "apply-pending" when a bundle really is pending. `applyOnNextLaunch`
      // promotes `staged` → `pending` and returns false when there is nothing staged — which is the
      // normal case mid-download. Reporting success there made the UI invite a restart that could
      // not apply anything, and restarting mid-download threw the partial download away.
      try {
        const promoted = await DashOta.applyOnNextLaunch();
        const pending = promoted || Boolean(((await DashOta.getState()) as { pendingBundleId?: string }).pendingBundleId);
        if (!pending) {
          logger.warn('applyUpdate: nothing staged yet — not restarting');
          return false;
        }
        setIsPending(true);
        setStatus('apply-pending');
        if (restart) DashOta.restart();
        return true;
      } catch (e) {
        // Surface it instead of throwing at the caller: a failed apply must never take the app down,
        // and the UI needs an error phase it can retry from.
        const msg = e instanceof Error ? e.message : String(e);
        setError(msg);
        setStatus('error');
        logger.error(`applyUpdate failed: ${msg}`);
        return false;
      }
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
    setIsPending(false);
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

  /**
   * The single user-facing state. Derived here — not in each host — because mapping eight lifecycle
   * statuses onto "what should the button say" is library knowledge, and every host that reimplements
   * it gets an edge case wrong (restarting mid-download being the expensive one).
   */
  const phase: OtaPhase = useMemo(() => {
    if (config.enabled === false || status === 'disabled') return 'none';
    if (status === 'error') return 'error';
    if (isPending) return 'ready'; // sticky: a staged bundle outranks any newer announcement
    if (status === 'downloading') return 'working';
    if (status === 'update-available') return 'available';
    // Keep the row stable across a re-check that already has an announcement in hand.
    if (status === 'checking' && availableUpdate) return 'available';
    return 'none';
  }, [config.enabled, status, isPending, availableUpdate]);

  const busy = isActing || status === 'downloading' || status === 'checking';

  const runAction = useCallback(async (): Promise<void> => {
    if (isActing) return;
    setIsActing(true);
    try {
      if (phase === 'available') await downloadUpdate();
      else if (phase === 'ready') await applyUpdate(true);
      else if (phase === 'error') await checkNow();
    } finally {
      setIsActing(false);
    }
  }, [isActing, phase, downloadUpdate, applyUpdate, checkNow]);

  const ui = useMemo<OtaUi>(() => {
    const version = availableUpdate?.bundleVersion ?? currentBundle?.bundleVersion;
    const fill = (s: string): string => s.replace('{version}', version == null ? '' : String(version));

    if (phase === 'none') {
      return {
        phase,
        visible: false,
        title: '',
        description: '',
        cta: null,
        ctaEnabled: false,
        busy,
        progress: null,
        blocking: false,
        action: runAction,
      };
    }

    const copy = { ...DEFAULT_UI_COPY[phase], ...config.uiCopy?.[phase] };
    return {
      phase,
      visible: true,
      title: fill(copy.title),
      // The raw error string stays on `ota.error` for logs/diagnostics — never in user-facing copy.
      description: fill(copy.description),
      cta: copy.cta,
      ctaEnabled: copy.cta != null && !busy,
      busy,
      // `downloadAndStage` is a single native call with no granular progress, so anything mid-flight
      // is honestly indeterminate rather than a fake percentage.
      progress: phase === 'working' && progress === 0 ? null : progress,
      blocking: isMandatory,
      action: runAction,
    };
  }, [phase, availableUpdate, currentBundle, config.uiCopy, busy, progress, isMandatory, runAction]);

  const channel = DashOta.getChannel();
  const value = useMemo<OtaUpdateState>(
    () => ({
      ui,
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
      ui,
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
