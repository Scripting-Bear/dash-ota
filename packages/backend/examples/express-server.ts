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

const app = express();

// Your own app middleware/routes live alongside OTA. A global JSON parser is fine as long as
// it stashes the raw bytes (the OTA request signature is over the exact body) via rawBodySaver.
app.use(express.json({ verify: rawBodySaver }));
app.get('/', (_req, res) => {
  res.json({ service: 'my-app', ota: '/ota/v1/*' });
});

// Mount the OTA distributor at the root. Everything it doesn't own falls through to your app.
app.use(
  dashOtaMiddleware({
    adminToken: process.env.OTA_ADMIN_TOKEN ?? 'dev-admin-token',
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
