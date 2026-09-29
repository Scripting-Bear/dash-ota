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
  flagInt,
  flagStr,
  isEncryptedPem,
  assertKnownFlags,
  MAX_INT32,
  type ParsedArgs,
  parseArgs,
  parseIntStrict,
  readBundleDir,
  resolveServer,
  resolveVerifyKey,
} from './util.js';
import {
  bundleProject,
  listReleases,
  type OnEvent,
  prepareRelease,
  releaseState,
  rollbackRelease,
  setNativePolicy,
  setPaused,
  setRollout,
  uploadRelease,
} from './core.js';
import { loadDashboardConfig, startDashboard } from './dashboard/server.js';
import { assertFlagValues, formatCommandHelp, formatGlobalHelp, isCommand } from './usage.js';

function asPlatform(v: string): Platform {
  if (v !== 'ios' && v !== 'android') throw new Error(`--platform must be ios|android (got "${v}")`);
  return v;
}
function asChannel(v: string): Channel {
  if (v !== 'dev' && v !== 'uat' && v !== 'prod') throw new Error(`--channel must be dev|uat|prod (got "${v}")`);
  return v;
}
function requireFlag(args: ParsedArgs, name: string): string {
  const value = flagStr(args, name);
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

/** Generate a signing keypair and write it out. */
async function cmdKeygen(args: ParsedArgs): Promise<void> {
  const out = flagStr(args, 'out', '.keys');
  const keyId = flagStr(args, 'key-id', 'key_dev_1');
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

  // Checked before any file is written, so a missing admin token cannot leave a key that was never registered.
  const registerTarget = flagBool(args, 'register') ? resolveServer(args) : undefined;

  // Encrypt the private key at rest unless explicitly opted out. Passphrase from flag/env, or a
  // prompt on a terminal (blank = store unencrypted, with a loud warning).
  let passphrase = flagStr(args, 'passphrase') || process.env.OTA_KEY_PASSPHRASE || '';
  const noEncrypt = flagBool(args, 'no-encrypt');
  if (!passphrase && !noEncrypt) {
    if (!process.stdin.isTTY) {
      throw new Error(
        'no passphrase for the signing key, and stdin is not a terminal to ask for one. Pass ' +
          '--passphrase <p> or set OTA_KEY_PASSPHRASE to encrypt it, or pass --no-encrypt to store it unencrypted.',
      );
    }
    passphrase = await askSecret('Passphrase to encrypt the signing key at rest (blank = store UNENCRYPTED)');
    if (!passphrase) console.warn('  ⚠ no passphrase entered: the signing key will be stored UNENCRYPTED.');
  }
  const kp = generateSigningKeyPair();
  const privatePem = passphrase ? encryptPrivateKeyPem(kp.privateKeyPem, passphrase) : kp.privateKeyPem;

  mkdirSync(out, { recursive: true });
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
  const target =
    registerTarget ??
    (flagBool(args, 'interactive') && (await askYesNo('\nRegister this public key with the backend now?', false))
      ? resolveServer(args)
      : undefined);
  if (target) {
    await adminPost(target.server, '/admin/keys', { keyId, publicKeyRawB64: kp.publicKeyRawB64 }, target.adminToken);
    console.log(`✓ registered ${keyId} with ${target.server}`);
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
  const { runtimeVersion, inputs, nativeSources } = fingerprintProject(project);
  const sourceNote = { git: ' (files git tracks)', disk: ' (files on disk)', absent: '' };
  console.log(`runtimeVersion: ${runtimeVersion}`);
  console.log(`  rn:      ${inputs.reactNativeVersion}`);
  console.log(`  hermes:  ${inputs.hermesVersion}`);
  console.log(
    `  deps:    ${inputs.nativeDependencies.length} (any change to package.json dependencies changes the runtimeVersion)`,
  );
  console.log(`  android: ${inputs.nativeDirHashes.android}${sourceNote[nativeSources.android]}`);
  console.log(`  ios:     ${inputs.nativeDirHashes.ios}${sourceNote[nativeSources.ios]}`);
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
  const bundleDir = requireFlag(args, 'bundle-dir');
  // Numbers are checked before any prompt, fingerprint or key read.
  const bundleVersionFlag = flagInt(args, 'bundle-version', 1, MAX_INT32);
  const rolloutFlag = flagInt(args, 'rollout', 0, 100);
  const minNativeBuild = flagInt(args, 'min-native-build', 0, MAX_INT32);
  const compressionLevel = flagInt(args, 'compression-level', 1, 22);
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

  const bundleVersion =
    bundleVersionFlag ??
    (interactive ? parseIntStrict(await ask('bundleVersion (integer)', '1'), 'bundleVersion', 1, MAX_INT32) : 1);

  const mandatory = flagBool(args, 'mandatory') || (interactive ? await askYesNo('mandatory update?', false) : false);
  const targetAppVersions =
    flagStr(args, 'target-app-versions') || (interactive ? await ask('targetAppVersions (blank = any)', '') : '');
  const rollout = rolloutFlag ?? (interactive ? parseIntStrict(await ask('rollout %', '100'), 'rollout', 0, 100) : 100);

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
      ...(compressionLevel !== undefined ? { compressionLevel } : {}),
      ...(minNativeBuild !== undefined ? { minNativeBuild } : {}),
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
    console.log(
      `${r.bundleId}  [${r.platform}/${r.channel}]  rt=${r.runtimeVersion} v${r.bundleVersion}  ${releaseState(r)}  adoption=${JSON.stringify(r.adoption)}`,
    );
  }
  if (releases.some((r) => r.finalized === false)) {
    console.log('\nINCOMPLETE: declared but never finalized (an interrupted publish). Devices are never offered it.');
  }
}

async function cmdRollout(args: ParsedArgs): Promise<void> {
  const bundleId = requireFlag(args, 'bundle-id');
  const pct = flagInt(args, 'pct', 0, 100) ?? 100;
  await setRollout(resolveServer(args), bundleId, pct);
  console.log(`✓ rollout updated to ${pct}%`);
}

async function cmdPause(args: ParsedArgs): Promise<void> {
  const bundleId = requireFlag(args, 'bundle-id');
  await setPaused(resolveServer(args), bundleId, !flagBool(args, 'resume'));
  console.log('✓ pause state updated');
}

async function cmdRollback(args: ParsedArgs): Promise<void> {
  const bundleId = requireFlag(args, 'bundle-id');
  await rollbackRelease(resolveServer(args), bundleId);
  console.log('✓ release rolled back (paused + flagged)');
}

async function cmdNativePolicy(args: ParsedArgs): Promise<void> {
  const storeUrl = flagStr(args, 'store-url');
  const channel = asChannel(flagStr(args, 'channel', 'dev'));
  const minSupportedNativeVersion = flagInt(args, 'min', 0, MAX_INT32) ?? 0;
  const severity = flagStr(args, 'severity', 'hard');
  if (severity !== 'soft' && severity !== 'hard') throw new Error(`--severity must be soft or hard (got "${severity}")`);
  await setNativePolicy(resolveServer(args), {
    channel,
    minSupportedNativeVersion,
    severity,
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
  const port = flagInt(args, 'port', 0, 65535) ?? 4460;
  const { config, project } = await loadDashboardConfig(flagStr(args, 'config', 'dash-ota.config.mjs'));
  const handle = await startDashboard({ config, project, port });
  console.log(`dash-ota dashboard → ${handle.url}`);
  console.log("  local only (127.0.0.1) · the link carries this session's token · Ctrl+C to stop");
  if (!flagBool(args, 'no-open')) openBrowser(handle.url);
  await new Promise<void>((done) => {
    process.once('SIGINT', () => {
      void handle.close().then(done);
    });
  });
}

function unknownCommand(command: string): void {
  console.error(`✗ unknown command "${command}"`);
  console.log(formatGlobalHelp());
  process.exitCode = 1;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const [command, ...rest] = args._;
  if (!command || command === 'help' || command === '-h') {
    const topic = command === 'help' ? rest[0] : undefined;
    if (!topic) console.log(formatGlobalHelp());
    else if (isCommand(topic)) console.log(formatCommandHelp(topic));
    else unknownCommand(topic);
    return;
  }
  if (!isCommand(command)) return unknownCommand(command);
  if (args.flags.help !== undefined || rest.includes('-h')) {
    console.log(formatCommandHelp(command));
    return;
  }
  assertKnownFlags(command, args);
  assertFlagValues(command, args);
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
      return unknownCommand(command);
  }
}

void main().catch((err: unknown) => {
  console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
