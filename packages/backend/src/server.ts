/**
 * dash-ota backend server — the standalone `node:http` distributor (zero runtime deps). It
 * wires the framework-agnostic {@link createOtaRoutes} into the tiny built-in {@link Router}.
 * The same routes can instead be mounted into an existing Express/Connect app via
 * {@link dashOtaMiddleware} (see `./index.ts`). The backend validates per-install request
 * signatures, applies targeting/rollout to pick a **pre-signed** manifest, hands out download
 * tokens, streams ciphertext, and records adoption/health — it never signs and never
 * holds a private key.
 *
 * @module server
 */

import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { type BackendConfig, loadConfig, type OtaBackendLogger } from './config.js';
import { Router } from './http.js';
import { createOtaRoutes } from './routes.js';
import { Store } from './store.js';

/** Build the configured router. Exported so tests can dispatch in-process. */
export function createRouter(store: Store, config: BackendConfig): Router {
  const router = new Router().register(createOtaRoutes(store, config));
  if (process.env.OTA_ACCESS_LOG === 'true') {
    router.accessLog = (method, path, status) => console.log(`[dash-ota] ${status} ${method} ${path}`);
  }
  return router;
}

/**
 * Whether `moduleUrl` is the script node was started with. Compared through the real path, so a
 * symlinked bin, a pnpm store path or a path with spaces still matches.
 */
export function isEntryPoint(moduleUrl: string, argv1: string | undefined): boolean {
  if (!argv1) return false;
  try {
    return moduleUrl === pathToFileURL(realpathSync(argv1)).href;
  } catch {
    return false;
  }
}

/** Start the server from the environment (used by `npm run backend`). */
async function main(): Promise<void> {
  const logger: OtaBackendLogger = {
    info: (message) => console.log(`[dash-ota-backend] ${message}`),
    warn: (message) => console.warn(`[dash-ota-backend] ${message}`),
    error: (message) => console.error(`[dash-ota-backend] ${message}`),
  };
  const config = { ...loadConfig(), logger };
  const store = new Store(config);
  const router = createRouter(store, config);
  await router.listen(config.port);
  console.log(`[dash-ota-backend] listening on http://localhost:${config.port} (require-sig=${config.requireRequestSignature})`);
}

// Run only when executed directly (not when imported by tests).
if (isEntryPoint(import.meta.url, process.argv[1])) {
  main().catch((err: unknown) => {
    console.error(`[dash-ota-backend] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
