/**
 * dash-ota CLI. Holds the Ed25519 signing private key (CI/release env only) and is the
 * single tool for the release lifecycle: keygen → fingerprint → bundle → publish → operate.
 *
 * Commands:
 *   keygen           generate an Ed25519 signing keypair (+ embeddable public key)
 *   register-key     register a trusted public key with the backend
 *   fingerprint      compute a project's runtimeVersion (native-compat key)
 *   bundle           run `react-native bundle` into a payload dir
 *   publish          encrypt + SIGN + upload a release (interactive release notes)
 *   list             list releases and adoption/health
 *   rollout|pause|rollback|native-policy   operate rollouts
 *   dashboard        local web UI over the same operations
 *
 * @module index
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { generateSigningKeyPair, randomAesKey, type Channel, type Platform } from '@dash-ota/shared';
import {
  adminPost,
  ask,
  askMultiline,
  askSecret,
  askYesNo,
  decryptPrivateKeyPem,
  encryptPrivateKeyPem,
  fingerprintProject,
  flagBool,
  flagStr,
  isEncryptedPem,
  assertKnownFlags,
  type ParsedArgs,
  parseArgs,
  readBundleDir,
  resolveServer,
  resolveVerifyKey,
} from './util.js';
import {
  bundleProject,
  listReleases,
  type OnEvent,
  prepareRelease,
  rollbackRelease,
  setNativePolicy,
  setPaused,
  setRollout,
  uploadRelease,
} from './core.js';
import { loadDashboardConfig, startDashboard } from './dashboard/server.js';

function asPlatform(v: string): Platform {
  if (v !== 'ios' && v !== 'android') throw new Error(`--platform must be ios|android (got "${v}")`);
  return v;
}
function asChannel(v: string): Channel {
  if (v !== 'dev' && v !== 'uat' && v !== 'prod') throw new Error(`--channel must be dev|uat|prod (got "${v}")`);
  return v;
}

/** Generate a signing keypair and write it out. */
async function cmdKeygen(args: ParsedArgs): Promise<void> {
  const out = flagStr(args, 'out', '.keys');
  const keyId = flagStr(args, 'key-id', 'key_dev_1');
  mkdirSync(out, { recursive: true });

  const privatePath = join(out, `${keyId}.private.pem`);
  const contentKeyPath = join(out, `${keyId}.content.key`);

  // Minting only the content key is the safe way to bring an existing channel to a version that
  // needs one. It is also the reason the guard below can afford to be absolute: there is a path
  // forward that does not involve replacing the signing key.
  if (flagBool(args, 'content-key-only')) {
    if (!existsSync(privatePath) && !existsSync(join(out, `${keyId}.private.enc.pem`))) {
      throw new Error(`no signing key for ${keyId} in ${out} — run keygen without --content-key-only first.`);
    }
    if (existsSync(contentKeyPath)) {
      console.log(`✓ ${contentKeyPath} already exists — nothing to do.`);
      return;
    }
    writeFileSync(contentKeyPath, randomAesKey().toString('base64'), { mode: 0o600 });
    console.log(`✓ wrote ${contentKeyPath}`);
    console.log('  Reuse it for every release on this channel; a fresh key per release re-uploads');
    console.log('  the whole bundle every time.');
    return;
  }

  // Refuse to replace a signing key. Every installed app embeds the matching PUBLIC key, so a new
  // private key means every future release is rejected by every device already in the field — and
  // only a store build can recover from that. It has to be deliberate.
  if (existsSync(privatePath) || existsSync(join(out, `${keyId}.private.enc.pem`))) {
    if (!flagBool(args, 'force')) {
      throw new Error(
        `${keyId} already has a signing key in ${out}. Overwriting it would invalidate every ` +
          `release for every app that already embeds the matching public key, recoverable only by ` +
          `shipping a new store build.\n` +
          `  • to add a missing content key:  dash-ota keygen --key-id ${keyId} --out ${out} --content-key-only\n` +
          `  • to rotate deliberately:        re-run with --force, then embed the new public key and ship a build`,
      );
    }
    console.warn(`  ⚠ --force: replacing the existing signing key for ${keyId}. Every installed app`);
    console.warn('    that embeds the old public key will reject every future release until a new');
    console.warn('    store build ships with the new one.');
  }

  const kp = generateSigningKeyPair();

  // Encrypt the private key at rest unless explicitly opted out. Passphrase from flag/env, or
  // prompt interactively (blank = store unencrypted, with a loud warning).
  let passphrase = flagStr(args, 'passphrase') || process.env.OTA_KEY_PASSPHRASE || '';
  const noEncrypt = flagBool(args, 'no-encrypt');
  if (!passphrase && !noEncrypt) {
    passphrase = await askSecret('Passphrase to encrypt the signing key at rest (blank = store UNENCRYPTED)');
  }
  const privatePem = passphrase ? encryptPrivateKeyPem(kp.privateKeyPem, passphrase) : kp.privateKeyPem;

  writeFileSync(privatePath, privatePem, { mode: 0o600 });
  // The content key seals blob bytes. It is carried in every manifest in the clear, so it is not
  // a secret from any device — but it must be the SAME key for every release on this channel, or
  // an unchanged file seals differently each time and the blob store keeps a copy per release.
  if (!existsSync(contentKeyPath)) {
    writeFileSync(contentKeyPath, randomAesKey().toString('base64'), { mode: 0o600 });
  }
  writeFileSync(join(out, `${keyId}.public.pem`), kp.publicKeyPem);
  writeFileSync(join(out, `${keyId}.public.json`), JSON.stringify({ keyId, publicKeyRawB64: kp.publicKeyRawB64 }, null, 2));
  console.log(`✓ wrote keypair to ${out}/${keyId}.*`);
  console.log(`  ✓ content key: ${contentKeyPath} — keep it, and reuse it for every release on this channel.`);
  if (passphrase) console.log('  ✓ private key encrypted at rest (AES-256-CBC).');
  else
    console.warn(
      '  ⚠ private key stored UNENCRYPTED — restrict .keys/ and prefer --passphrase / OTA_KEY_PASSPHRASE (e.g. in CI).',
    );
  console.log(`\n  keyId:            ${keyId}`);
  console.log(`  publicKeyRawB64:  ${kp.publicKeyRawB64}`);
  console.log(`\n  → Embed publicKeyRawB64 in the app (per channel) and KEEP THE PRIVATE KEY in CI secrets only.`);
  // Only ever prompt when the caller asked for a conversation. A bare `keygen` in CI must not
  // block on a question nobody can answer; `--register` is the scripted way to say yes.
  const register = flagBool(args, 'register')
    ? true
    : flagBool(args, 'interactive') && (await askYesNo('\nRegister this public key with the backend now?', false));
  if (register) {
    const { server, adminToken } = resolveServer(args);
    await adminPost(server, '/admin/keys', { keyId, publicKeyRawB64: kp.publicKeyRawB64 }, adminToken);
    console.log(`✓ registered ${keyId} with ${server}`);
  }
}

/**
 * Find the channel content key for an encrypted publish.
 *
 * Order: `--content-key` (base64), `OTA_CONTENT_KEY`, then `<key dir>/<keyId>.content.key` written
 * by `keygen`. Missing is a hard error rather than a fresh random key: a per-release key still
 * produces a valid, decryptable release, so the failure would be invisible — every publish would
 * simply re-upload the whole bundle and the blob store would grow one full copy per release.
 *
 * @param args - parsed CLI args.
 * @param keyPath - path to the signing key, whose directory is searched.
 * @param keyId - the signing key id, which names the content key file.
 * @returns the 32-byte content key.
 * @throws when no key is found, or one is found but is not 32 bytes.
 */
function resolveContentKey(args: ParsedArgs, keyPath: string, keyId: string): Buffer {
  const inline = flagStr(args, 'content-key') || process.env.OTA_CONTENT_KEY || '';
  const path = join(dirname(keyPath), `${keyId}.content.key`);
  let b64 = inline;
  if (!b64) {
    if (!existsSync(path)) {
      throw new Error(
        `no content key for ${keyId}. Expected ${path} (written by \`dash-ota keygen\`), ` +
          '--content-key <base64>, or OTA_CONTENT_KEY. Reuse ONE key per channel so the blob store ' +
          'can share unchanged files between releases — or publish with --no-encrypt.',
      );
    }
    b64 = readFileSync(path, 'utf8').trim();
  }
  const key = Buffer.from(b64, 'base64');
  if (key.length !== 32) throw new Error(`content key must be 32 bytes (got ${key.length}) — expected base64 of 32 bytes`);
  return key;
}

/** Register a trusted public key with the backend. */
async function cmdRegisterKey(args: ParsedArgs): Promise<void> {
  const keyId = flagStr(args, 'key-id', 'key_dev_1');
  let pub = flagStr(args, 'pub');
  const keyFile = flagStr(args, 'key-file');
  if (!pub && keyFile) pub = (JSON.parse(readFileSync(keyFile, 'utf8')) as { publicKeyRawB64: string }).publicKeyRawB64;
  if (!pub) throw new Error('provide --pub <rawB64> or --key-file <keygen .public.json>');
  const { server, adminToken } = resolveServer(args);
  await adminPost(server, '/admin/keys', { keyId, publicKeyRawB64: pub }, adminToken);
  console.log(`✓ registered ${keyId} with ${server}`);
}

/** Print a project's runtimeVersion. */
function cmdFingerprint(args: ParsedArgs): void {
  const project = flagStr(args, 'project', process.cwd());
  const { runtimeVersion, inputs } = fingerprintProject(project);
  console.log(`runtimeVersion: ${runtimeVersion}`);
  console.log(`  rn:      ${inputs.reactNativeVersion}`);
  console.log(`  hermes:  ${inputs.hermesVersion}`);
  console.log(`  deps:    ${inputs.nativeDependencies.length}`);
  console.log(`  android: ${inputs.nativeDirHashes.android}`);
  console.log(`  ios:     ${inputs.nativeDirHashes.ios}`);
}

const printEvent: OnEvent = (event) => {
  if (event.type === 'log') console.log(event.message);
  else if (event.type === 'upload')
    process.stdout.write(`\r  uploaded ${event.done}/${event.total}${event.done === event.total ? '\n' : ''}`);
};

/** Wrap `react-native bundle` into a payload dir. */
async function cmdBundle(args: ParsedArgs): Promise<void> {
  const project = flagStr(args, 'project', process.cwd());
  const platform = asPlatform(flagStr(args, 'platform', 'android'));
  const out = flagStr(args, 'out', join(project, '.dash-ota-bundle', platform));
  const hermes = flagBool(args, 'hermes');
  await bundleProject(
    { project, platform, out, entry: flagStr(args, 'entry', 'index.js'), dev: flagBool(args, 'dev'), hermes },
    printEvent,
  );
  console.log(`\n✓ bundle written to ${out}`);
  if (!hermes) {
    console.log('  NOTE: this is a PLAIN JS bundle. For Hermes builds, re-run with --hermes to emit HBC before publish.');
  }
  console.log(`  next: dash-ota publish --bundle-dir ${out} --platform ${platform} ...`);
}

/** Build, sign, and upload a release. */
async function cmdPublish(args: ParsedArgs): Promise<void> {
  const interactive = flagBool(args, 'interactive');
  const bundleDir = flagStr(args, 'bundle-dir');
  if (!bundleDir) throw new Error('--bundle-dir is required');
  const files = readBundleDir(bundleDir);
  if (files.length === 0) throw new Error(`no files in ${bundleDir}`);

  const platform = asPlatform(
    flagStr(args, 'platform') || (interactive ? await ask('platform (ios|android)', 'android') : 'android'),
  );
  const channel = asChannel(flagStr(args, 'channel') || (interactive ? await ask('channel (dev|uat|prod)', 'dev') : 'dev'));

  // runtimeVersion: explicit, or auto-fingerprint the project (hybrid policy).
  let runtimeVersion = flagStr(args, 'runtime-version');
  if (!runtimeVersion || runtimeVersion === 'auto') {
    const project = flagStr(args, 'project', process.cwd());
    runtimeVersion = fingerprintProject(project).runtimeVersion;
    console.log(`runtimeVersion (auto): ${runtimeVersion}`);
  }

  const bundleVersion = Number.parseInt(
    flagStr(args, 'bundle-version') || (interactive ? await ask('bundleVersion (integer)', '1') : '1'),
    10,
  );
  if (!Number.isInteger(bundleVersion)) throw new Error('--bundle-version must be an integer');

  const mandatory = flagBool(args, 'mandatory') || (interactive ? await askYesNo('mandatory update?', false) : false);
  const targetAppVersions =
    flagStr(args, 'target-app-versions') || (interactive ? await ask('targetAppVersions (blank = any)', '') : '');
  const rollout = Number.parseInt(flagStr(args, 'rollout') || (interactive ? await ask('rollout %', '100') : '100'), 10);

  let releaseNotes = flagStr(args, 'release-note');
  if (!releaseNotes && interactive) releaseNotes = await askMultiline('Release notes');

  const keyId = flagStr(args, 'key-id', 'key_dev_1');
  const keyPath = flagStr(args, 'key', join('.keys', `${keyId}.private.pem`));
  if (!existsSync(keyPath)) throw new Error(`signing key not found: ${keyPath} (run: dash-ota keygen)`);
  let privateKeyPem = readFileSync(keyPath, 'utf8');
  if (isEncryptedPem(privateKeyPem)) {
    const passphrase =
      flagStr(args, 'passphrase') ||
      process.env.OTA_KEY_PASSPHRASE ||
      (interactive ? await askSecret('Signing key passphrase') : '');
    if (!passphrase) throw new Error('signing key is encrypted — provide --passphrase or OTA_KEY_PASSPHRASE');
    try {
      privateKeyPem = decryptPrivateKeyPem(privateKeyPem, passphrase);
    } catch {
      throw new Error('failed to decrypt the signing key — wrong passphrase?');
    }
  }

  const appId = flagStr(args, 'app-id') || (interactive ? await ask('appId (package name / bundle id)', '') : '');
  if (!appId) throw new Error('--app-id is required: the device refuses a manifest built for a different app');
  const encrypt = !flagBool(args, 'no-encrypt');
  const contentKey = encrypt ? resolveContentKey(args, keyPath, keyId) : undefined;
  const levelFlag = flagStr(args, 'compression-level');
  const bundleIdFlag = flagStr(args, 'bundle-id');

  const prepared = await prepareRelease(
    {
      files,
      platform,
      channel,
      runtimeVersion,
      bundleVersion,
      appId,
      mandatory,
      keyId,
      privateKeyPem,
      encrypt,
      verifyKey: resolveVerifyKey(args, keyPath, privateKeyPem),
      ...(contentKey ? { contentKey } : {}),
      ...(bundleIdFlag ? { bundleId: bundleIdFlag } : {}),
      ...(levelFlag ? { compressionLevel: Number.parseInt(levelFlag, 10) } : {}),
      ...(targetAppVersions ? { targetAppVersions } : {}),
      ...(releaseNotes ? { releaseNotes } : {}),
    },
    printEvent,
  );

  if (flagBool(args, 'no-upload')) {
    const outDir = join(bundleDir, '..', `${prepared.bundleId}.v2`);
    mkdirSync(join(outDir, 'blobs'), { recursive: true });
    writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(prepared.signed, null, 2));
    for (const [sha, bytes] of prepared.blobs) writeFileSync(join(outDir, 'blobs', sha), bytes);
    console.log(`✓ wrote artifact (not uploaded): ${outDir}`);
    return;
  }

  const target = resolveServer(args);
  const result = await uploadRelease(target, prepared, rollout, printEvent);
  console.log(`✓ published to ${target.server}:`, JSON.stringify(result.response));
}

/** List releases + adoption. */
async function cmdList(args: ParsedArgs): Promise<void> {
  const releases = await listReleases(resolveServer(args));
  if (releases.length === 0) {
    console.log('(no releases)');
    return;
  }
  for (const r of releases) {
    const state = r.rolledBack ? 'ROLLED_BACK' : r.paused ? 'PAUSED' : `${r.rolloutPercentage}%`;
    console.log(
      `${r.bundleId}  [${r.platform}/${r.channel}]  rt=${r.runtimeVersion} v${r.bundleVersion}  ${state}  adoption=${JSON.stringify(r.adoption)}`,
    );
  }
}

async function cmdRollout(args: ParsedArgs): Promise<void> {
  await setRollout(resolveServer(args), flagStr(args, 'bundle-id'), Number.parseInt(flagStr(args, 'pct', '100'), 10));
  console.log('✓ rollout updated');
}

async function cmdPause(args: ParsedArgs): Promise<void> {
  await setPaused(resolveServer(args), flagStr(args, 'bundle-id'), !flagBool(args, 'resume'));
  console.log('✓ pause state updated');
}

async function cmdRollback(args: ParsedArgs): Promise<void> {
  await rollbackRelease(resolveServer(args), flagStr(args, 'bundle-id'));
  console.log('✓ release rolled back (paused + flagged)');
}

async function cmdNativePolicy(args: ParsedArgs): Promise<void> {
  const storeUrl = flagStr(args, 'store-url');
  await setNativePolicy(resolveServer(args), {
    channel: asChannel(flagStr(args, 'channel', 'dev')),
    minSupportedNativeVersion: Number.parseInt(flagStr(args, 'min', '0'), 10),
    severity: flagStr(args, 'severity', 'hard'),
    ...(storeUrl ? { storeUrl } : {}),
  });
  console.log('✓ native policy updated');
}

function openBrowser(url: string): void {
  const [command, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];
  const child = spawn(command, args, { stdio: 'ignore', detached: true });
  child.on('error', () => console.log('  (could not open a browser — open the link above yourself)'));
  child.unref();
}

/** Serve the local dashboard until Ctrl+C. */
async function cmdDashboard(args: ParsedArgs): Promise<void> {
  const { config, project } = await loadDashboardConfig(flagStr(args, 'config', 'dash-ota.config.mjs'));
  const handle = await startDashboard({ config, project, port: Number.parseInt(flagStr(args, 'port', '4460'), 10) });
  console.log(`dash-ota dashboard → ${handle.url}`);
  console.log("  local only (127.0.0.1) · the link carries this session's token · Ctrl+C to stop");
  if (!flagBool(args, 'no-open')) openBrowser(handle.url);
  await new Promise<void>((done) => {
    process.once('SIGINT', () => {
      void handle.close().then(done);
    });
  });
}

function printHelp(): void {
  console.log(`dash-ota <command> [flags]

  keygen          --out .keys --key-id key_dev_1 [--passphrase <p> | --no-encrypt]
                  [--content-key-only] [--force] [--register --server --admin-token]
                  [--interactive]
  register-key    --key-id <id> (--pub <rawB64> | --key-file <.public.json>)
  fingerprint     --project <path>
  bundle          --project <path> --platform ios|android --out <dir> [--dev] [--hermes]
  publish         --bundle-dir <dir> --app-id <package name> --platform ios|android
                  --channel dev|uat|prod --runtime-version auto|<R> --bundle-version <n>
                  [--mandatory] [--target-app-versions <range>] [--rollout <pct>]
                  [--release-note <txt>] [--bundle-id <id>] [--interactive]
                  [--no-encrypt] [--content-key <b64>] [--compression-level <1-22>] [--no-upload]
                  [--key <pem>] [--key-id <id>] [--passphrase <p>] [--verify-pub <rawB64>]
                  [--server --admin-token]
  list            [--server --admin-token]
  rollout         --bundle-id <id> --pct <0-100>
  pause           --bundle-id <id> [--resume]
  rollback        --bundle-id <id>
  native-policy   --channel <c> --min <build> --severity soft|hard [--store-url <url>]
  dashboard       [--config dash-ota.config.mjs] [--port 4460] [--no-open]
                  local web UI for all of the above (127.0.0.1 only)

  Wire format: protocol 2 — one content-addressed blob per distinct file, compressed with zstd
  and (unless --no-encrypt) encrypted per release. Publishing uploads only the blobs the server
  is missing; a device downloads only the files it does not already hold. --app-id is required:
  a device refuses a manifest built for a different app. Releases are immutable once finalized.

  Trust root: --admin-token (or OTA_ADMIN_TOKEN) is required for server calls — no default.
  Plaintext http:// to a remote host is refused (use https://, or --allow-insecure on a
  trusted network). Encrypted signing keys need a passphrase — prefer OTA_KEY_PASSPHRASE or the
  masked prompt over --passphrase (a CLI flag is visible in process listings / shell history).
`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  if (command) assertKnownFlags(command, args);
  switch (command) {
    case 'keygen':
      return cmdKeygen(args);
    case 'register-key':
      return cmdRegisterKey(args);
    case 'fingerprint':
      return cmdFingerprint(args);
    case 'bundle':
      return cmdBundle(args);
    case 'publish':
      return cmdPublish(args);
    case 'list':
      return cmdList(args);
    case 'rollout':
      return cmdRollout(args);
    case 'pause':
      return cmdPause(args);
    case 'rollback':
      return cmdRollback(args);
    case 'native-policy':
      return cmdNativePolicy(args);
    case 'dashboard':
      return cmdDashboard(args);
    default:
      printHelp();
      if (command && command !== 'help') process.exitCode = 1;
  }
}

void main().catch((err: unknown) => {
  console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
