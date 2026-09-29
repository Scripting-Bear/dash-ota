/**
 * Example config for `dash-ota dashboard`.
 *
 * Copy to `dash-ota.config.mjs` in your project root and edit. Relative paths resolve against
 * `project` (which itself defaults to this file's directory).
 *
 * This file is imported as an ES module, so keep admin tokens in the environment rather than
 * here — it is the kind of file that ends up committed.
 */
export default {
  // App root, relative to this file. Defaults to '.'.
  // project: '.',

  environments: {
    dev: {
      server: 'http://localhost:4455',
      // Without adminToken the environment is listed but read-only.
      adminToken: process.env.OTA_ADMIN_TOKEN_DEV,
      channel: 'dev',
      appId: 'com.your.app.dev',
      // Fixed string — the dashboard does not fingerprint. Re-run `dash-ota fingerprint`
      // after any native change and update this, or you will publish under a stale runtime.
      runtimeVersion: 'rt1',
      keyId: 'key_dev_1',
      keyPath: '.keys/key_dev_1.private.pem',
    },

    prod: {
      server: 'https://ota.yourapi.com',
      adminToken: process.env.OTA_ADMIN_TOKEN_PROD,
      channel: 'prod',
      appId: 'com.your.app',
      runtimeVersion: 'rt1',
      keyId: 'key_prod_1',
      keyPath: '.keys/key_prod_1.private.pem',
      // Defaults to `<keyId>.content.key` beside the signing key.
      // contentKeyPath: '.keys/key_prod_1.content.key',
      // For an encrypted signing key; falls back to OTA_KEY_PASSPHRASE.
      // passphrase: process.env.OTA_KEY_PASSPHRASE,
      platforms: ['android', 'ios'],
      // Every write needs the environment name typed to confirm, and New-release
      // defaults to a 10% rollout instead of 100%.
      protected: true,
    },
  },

  // Optional: replace the default build (`react-native bundle` + hermesc).
  // bundle: async ({ platform, out, project, env, log }) => {
  //   log(`building ${platform} for ${env}`);
  //   await myBundler({ platform, out, project });
  // },
};
