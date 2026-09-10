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
 *
 * @module index
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  buildReleaseV2,
  generateSigningKeyPair,
  randomAesKey,
  signManifest,
  type Channel,
  type Platform,
  verifyManifest,
} from '@dash-ota/shared';
import {
  adminGet,
  adminPost,
  adminPutBytes,
  formatBytes,
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
  type ParsedArgs,
  parseArgs,
  readBundleDir,
  resolveServer,
  resolveVerifyKey,
} from './util.js';

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
  const kp = generateSigningKeyPair();

  // Encrypt the private key at rest unless explicitly opted out. Passphrase from flag/env, or
  // prompt interactively (blank = store unencrypted, with a loud warning).
  let passphrase = flagStr(args, 'passphrase') || process.env.OTA_KEY_PASSPHRASE || '';
  const noEncrypt = flagBool(args, 'no-encrypt');
  if (!passphrase && !noEncrypt) {
    passphrase = await askSecret('Passphrase to encrypt the signing key at rest (blank = store UNENCRYPTED)');
  }
  const privatePem = passphrase ? encryptPrivateKeyPem(kp.privateKeyPem, passphrase) : kp.privateKeyPem;

  writeFileSync(join(out, `${keyId}.private.pem`), privatePem, { mode: 0o600 });
  // The content key seals blob bytes. It is carried in every manifest in the clear, so it is not
  // a secret from any device — but it must be the SAME key for every release on this channel, or
  // an unchanged file seals differently each time and the blob store keeps a copy per release.
  const contentKeyPath = join(out, `${keyId}.content.key`);
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

/** Locate the RN-bundled `hermesc` binary for the current OS, or null if absent. */
function resolveHermesc(project: string): string | null {
  const base = join(project, 'node_modules', 'react-native', 'sdks', 'hermesc');
  const rel =
    process.platform === 'darwin'
      ? 'osx-bin/hermesc'
      : process.platform === 'win32'
        ? 'win64-bin/hermesc.exe'
        : 'linux64-bin/hermesc';
  const p = join(base, rel);
  return existsSync(p) ? p : null;
}

/** Wrap `react-native bundle` into a payload dir. */
function cmdBundle(args: ParsedArgs): void {
  const project = flagStr(args, 'project', process.cwd());
  const platform = asPlatform(flagStr(args, 'platform', 'android'));
  const out = flagStr(args, 'out', join(project, '.dash-ota-bundle', platform));
  const entry = flagStr(args, 'entry', 'index.js');
  const dev = flagBool(args, 'dev');
  mkdirSync(out, { recursive: true });
  const bundleName = platform === 'android' ? 'index.android.bundle' : 'main.jsbundle';
  const cmd = [
    'react-native',
    'bundle',
    `--platform=${platform}`,
    `--dev=${dev}`,
    `--entry-file=${entry}`,
    `--bundle-output=${join(out, bundleName)}`,
    `--assets-dest=${out}`,
  ];
  console.log(`$ npx ${cmd.join(' ')}`);
  const res = spawnSync('npx', cmd, { cwd: project, stdio: 'inherit' });
  if (res.status !== 0) throw new Error(`react-native bundle failed (exit ${res.status ?? 'null'})`);
  console.log(`\n✓ bundle written to ${out}`);

  const plainBundle = join(out, bundleName);
  if (flagBool(args, 'hermes')) {
    // Compile to Hermes bytecode (HBC) and replace the plain JS bundle in place (same name RN
    // loads). Fail loud if hermesc is missing rather than silently shipping a non-HBC bundle.
    const hermesc = resolveHermesc(project);
    if (!hermesc) {
      throw new Error(
        '--hermes requested but hermesc was not found under node_modules/react-native/sdks/hermesc — cannot produce an HBC bundle',
      );
    }
    const hbc = `${plainBundle}.hbc`;
    console.log(`$ ${hermesc} -emit-binary -O -out ${hbc} ${plainBundle}`);
    const hres = spawnSync(hermesc, ['-emit-binary', '-O', '-out', hbc, plainBundle], { stdio: 'inherit' });
    if (hres.status !== 0) throw new Error(`hermesc failed (exit ${hres.status ?? 'null'})`);
    renameSync(hbc, plainBundle);
    console.log(`✓ compiled Hermes bytecode (HBC): ${plainBundle}`);
  } else {
    console.log(`  NOTE: this is a PLAIN JS bundle. For Hermes builds, re-run with --hermes to emit HBC before publish.`);
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

  const bundleId = flagStr(args, 'bundle-id', `bnd_${runtimeVersion}_${bundleVersion}_${Date.now().toString(36)}`);

  const appId = flagStr(args, 'app-id') || (interactive ? await ask('appId (package name / bundle id)', '') : '');
  if (!appId) throw new Error('--app-id is required: the device refuses a manifest built for a different app');
  const encrypt = !flagBool(args, 'no-encrypt');
  const contentKey = encrypt ? resolveContentKey(args, keyPath, keyId) : undefined;
  const levelFlag = flagStr(args, 'compression-level');
  const bundlePath = files.find((f) => /(^|\/)(index\.android\.bundle|main\.jsbundle)$/.test(f.path))?.path;
  if (!bundlePath) throw new Error('no index.android.bundle or main.jsbundle in the bundle dir');

  const built = await buildReleaseV2({
    bundleId,
    runtimeVersion,
    bundleVersion,
    platform,
    channel,
    appId,
    mandatory,
    files,
    bundlePath,
    keyId,
    encrypt,
    ...(contentKey ? { contentKey } : {}),
    ...(levelFlag ? { bundleCompressionLevel: Number.parseInt(levelFlag, 10) } : {}),
    ...(targetAppVersions ? { targetAppVersions } : {}),
    ...(releaseNotes ? { releaseNotes } : {}),
  });
  const signed = signManifest(built.manifest, privateKeyPem);

  // Self-verify BEFORE upload against the public key the app embeds (or, failing that, a
  // consistency check against the signing key). Catches a wrong key / keyId mismatch that would
  // otherwise ship an update every device rejects.
  const verify = resolveVerifyKey(args, keyPath, privateKeyPem);
  if (!verifyManifest(signed, verify.key)) {
    throw new Error(
      `self-verify FAILED against ${verify.source}: the app embeds this key and would REJECT this update. Aborting.`,
    );
  }
  console.log(`  ✓ self-verified signature (${verify.source})`);

  const plaintextBytes = files.reduce((sum, f) => sum + f.data.length, 0);
  const storedBytes = [...built.blobs.values()].reduce((sum, b) => sum + b.length, 0);
  console.log(`\n  bundleId:        ${bundleId}`);
  console.log(`  runtimeVersion:  ${runtimeVersion}   bundleVersion: ${bundleVersion}`);
  console.log(
    `  files:           ${files.length} (${built.blobs.size} distinct blobs)   ` +
      `${formatBytes(plaintextBytes)} → ${formatBytes(storedBytes)}   rollout: ${rollout}%`,
  );
  console.log(`  encryption:      ${built.manifest.encryption.mode}`);

  if (flagBool(args, 'no-upload')) {
    const outDir = join(bundleDir, '..', `${bundleId}.v2`);
    mkdirSync(join(outDir, 'blobs'), { recursive: true });
    writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(signed, null, 2));
    for (const [sha, bytes] of built.blobs) writeFileSync(join(outDir, 'blobs', sha), bytes);
    console.log(`✓ wrote artifact (not uploaded): ${outDir}`);
    return;
  }

  const { server, adminToken } = resolveServer(args);

  // Three steps: declare the release, upload what the server is missing, then finalize. Re-running
  // after a failure re-declares the same manifest and uploads only the gap.
  const created = (await adminPost(
    server,
    '/admin/releases',
    { signedManifest: signed, rolloutPercentage: rollout },
    adminToken,
  )) as {
    bundleId: string;
    missing: string[];
  };
  const missing = created.missing ?? [];
  console.log(
    `  uploading:       ${missing.length} of ${built.blobs.size} blobs (${built.blobs.size - missing.length} already present)`,
  );

  let done = 0;
  for (const sha of missing) {
    const bytes = built.blobs.get(sha);
    if (!bytes) throw new Error(`server asked for a blob this release does not contain: ${sha}`);
    await adminPutBytes(server, `/admin/releases/${encodeURIComponent(bundleId)}/blobs/${sha}`, bytes, adminToken);
    done += 1;
    process.stdout.write(`\r  uploaded ${done}/${missing.length}`);
  }
  if (missing.length > 0) process.stdout.write('\n');

  const res = await adminPost(server, `/admin/releases/${encodeURIComponent(bundleId)}/finalize`, {}, adminToken);
  console.log(`✓ published to ${server}:`, JSON.stringify(res));
}

/** List releases + adoption. */
async function cmdList(args: ParsedArgs): Promise<void> {
  const { server, adminToken } = resolveServer(args);
  const data = (await adminGet(server, '/admin/releases', adminToken)) as {
    releases: {
      bundleId: string;
      channel: string;
      platform: string;
      runtimeVersion: string;
      bundleVersion: number;
      rolloutPercentage: number;
      paused: boolean;
      rolledBack: boolean;
      adoption: Record<string, number>;
    }[];
  };
  if (data.releases.length === 0) {
    console.log('(no releases)');
    return;
  }
  for (const r of data.releases) {
    const state = r.rolledBack ? 'ROLLED_BACK' : r.paused ? 'PAUSED' : `${r.rolloutPercentage}%`;
    console.log(
      `${r.bundleId}  [${r.platform}/${r.channel}]  rt=${r.runtimeVersion} v${r.bundleVersion}  ${state}  adoption=${JSON.stringify(r.adoption)}`,
    );
  }
}

async function cmdRollout(args: ParsedArgs): Promise<void> {
  const { server, adminToken } = resolveServer(args);
  await adminPost(
    server,
    '/admin/rollout',
    { bundleId: flagStr(args, 'bundle-id'), rolloutPercentage: Number.parseInt(flagStr(args, 'pct', '100'), 10) },
    adminToken,
  );
  console.log('✓ rollout updated');
}
async function cmdPause(args: ParsedArgs): Promise<void> {
  const { server, adminToken } = resolveServer(args);
  await adminPost(
    server,
    '/admin/pause',
    { bundleId: flagStr(args, 'bundle-id'), paused: !flagBool(args, 'resume') },
    adminToken,
  );
  console.log('✓ pause state updated');
}
async function cmdRollback(args: ParsedArgs): Promise<void> {
  const { server, adminToken } = resolveServer(args);
  await adminPost(server, '/admin/rollback', { bundleId: flagStr(args, 'bundle-id') }, adminToken);
  console.log('✓ release rolled back (paused + flagged)');
}
async function cmdNativePolicy(args: ParsedArgs): Promise<void> {
  const { server, adminToken } = resolveServer(args);
  await adminPost(
    server,
    '/admin/native-policy',
    {
      channel: asChannel(flagStr(args, 'channel', 'dev')),
      minSupportedNativeVersion: Number.parseInt(flagStr(args, 'min', '0'), 10),
      severity: flagStr(args, 'severity', 'hard'),
      storeUrl: flagStr(args, 'store-url') || undefined,
    },
    adminToken,
  );
  console.log('✓ native policy updated');
}

function printHelp(): void {
  console.log(`dash-ota <command> [flags]

  keygen          --out .keys --key-id key_dev_1 [--passphrase <p> | --no-encrypt]
                  [--register --server --admin-token] [--interactive]
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
    default:
      printHelp();
      if (command && command !== 'help') process.exitCode = 1;
  }
}

void main().catch((err: unknown) => {
  console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
