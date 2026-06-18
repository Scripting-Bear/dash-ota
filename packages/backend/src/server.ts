/**
 * dash-ota backend server — the standalone `node:http` distributor (zero runtime deps). It
 * wires the framework-agnostic {@link createOtaRoutes} into the tiny built-in {@link Router}.
 * The same routes can instead be mounted into an existing Express/Connect app via
 * {@link dashOtaMiddleware} (see `./index.ts`). The backend validates per-install request
 * signatures, applies targeting/rollout to pick a **pre-signed** manifest, hands out one-time
 * download tokens, streams ciphertext, and records adoption/health — it never signs and never
 * holds a private key.
 *
 * @module server
 */

import { type BackendConfig, loadConfig } from './config.js';
import { Router } from './http.js';
import { createOtaRoutes } from './routes.js';
import { Store } from './store.js';

/** Build the configured router. Exported so tests can dispatch in-process. */
export function createRouter(store: Store, config: BackendConfig): Router {
  return new Router().register(createOtaRoutes(store, config));
}

/** Start the server from the environment (used by `npm run backend`). */
async function main(): Promise<void> {
  const config = loadConfig();
  const store = new Store(config);
  const router = createRouter(store, config);
  await router.listen(config.port);
  console.log(`[dash-ota-backend] listening on http://localhost:${config.port} (require-sig=${config.requireRequestSignature})`);
}

// Run only when executed directly (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
