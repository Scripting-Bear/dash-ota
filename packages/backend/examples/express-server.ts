/**
 * Example: drop the dash-ota distributor into an existing Express app.
 *
 * Run with: `npm -w @dash-ota/backend run express`
 *
 * Shows the config-driven extension points — your own enroll auth, confirm analytics, a
 * logger, and co-existing app routes/middleware — all without forking the OTA core.
 *
 * @module examples/express-server
 */

import express from 'express';
import { rawBodySaver, dashOtaMiddleware } from '@dash-ota/backend';

// No fallback: a default token would be a public admin credential for anyone who read this file.
const adminToken = process.env.OTA_ADMIN_TOKEN;
if (!adminToken) {
  console.error('[example] OTA_ADMIN_TOKEN is not set. Export a long random secret and run again.');
  process.exit(1);
}

const app = express();

// Your own app middleware/routes live alongside OTA. A global JSON parser is fine as long as
// it stashes the raw bytes (the OTA request signature is over the exact body) via rawBodySaver.
// The limit must fit a release manifest: the 100 kB default rejects one of a few hundred files.
app.use(express.json({ limit: '32mb', verify: rawBodySaver }));
app.get('/', (_req, res) => {
  res.json({ service: 'my-app', ota: '/ota/v2/*' });
});

// Mount the OTA distributor at the root. Everything it doesn't own falls through to your app.
app.use(
  dashOtaMiddleware({
    adminToken,
    // Plug your real auth here — validate the device's session token against your IdP.
    verifyEnrollToken: async (token) => {
      if (!token) return false;
      // e.g. return await myAuth.verifySession(token);
      return token.startsWith('session_');
    },
    // Fleet telemetry without touching the core.
    onConfirm: (e) => {
      console.log(`[confirm] ${e.installId} ${e.bundleId} -> ${e.status}${e.autoPaused ? ' (AUTO-PAUSED)' : ''}`);
    },
    onPublish: (e) => console.log(`[publish] ${e.bundleId} ${e.platform}/${e.channel} v${e.bundleVersion}`),
    logger: console,
  }),
);

const port = Number(process.env.PORT ?? 4455);
app.listen(port, () => console.log(`[example] express + dash-ota on http://localhost:${port}`));
