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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildRelease,
  type Channel,
  generateSigningKeyPair,
  type Platform,
  signManifest,
} from '@dash-ota/shared';
import {
  adminGet,
  adminPost,
  ask,
  askMultiline,
  askYesNo,
  fingerprintProject,
  flagBool,
  flagStr,
  type ParsedArgs,
  parseArgs,
  readBundleDir,
  resolveServer,
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
  writeFileSync(join(out, `${keyId}.private.pem`), kp.privateKeyPem, { mode: 0o600 });
  writeFileSync(join(out, `${keyId}.public.pem`), kp.publicKeyPem);
  writeFileSync(join(out, `${keyId}.public.json`), JSON.stringify({ keyId, publicKeyRawB64: kp.publicKeyRawB64 }, null, 2));
  console.log(`✓ wrote keypair to ${out}/${keyId}.*`);
  console.log(`\n  keyId:            ${keyId}`);
  console.log(`  publicKeyRawB64:  ${kp.publicKeyRawB64}`);
  console.log(`\n  → Embed publicKeyRawB64 in the app (per channel) and KEEP THE PRIVATE KEY in CI secrets only.`);
  if (await askYesNo('\nRegister this public key with the backend now?', false)) {
    const { server, adminToken } = resolveServer(args);
    await adminPost(server, '/admin/keys', { keyId, publicKeyRawB64: kp.publicKeyRawB64 }, adminToken);
    console.log(`✓ registered ${keyId} with ${server}`);
  }
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
  console.log(`  NOTE: for Hermes builds, compile ${bundleName} with the binary's hermesc (HBC) before publish.`);
  console.log(`  next: dash-ota publish --bundle-dir ${out} --platform ${platform} ...`);
}

/** Build, sign, and upload a release. */
async function cmdPublish(args: ParsedArgs): Promise<void> {
  const interactive = flagBool(args, 'interactive');
  const bundleDir = flagStr(args, 'bundle-dir');
  if (!bundleDir) throw new Error('--bundle-dir is required');
  const files = readBundleDir(bundleDir);
  if (files.length === 0) throw new Error(`no files in ${bundleDir}`);

  const platform = asPlatform(flagStr(args, 'platform') || (interactive ? await ask('platform (ios|android)', 'android') : 'android'));
  const channel = asChannel(flagStr(args, 'channel') || (interactive ? await ask('channel (dev|uat|prod)', 'dev') : 'dev'));

  // runtimeVersion: explicit, or auto-fingerprint the project (hybrid policy).
  let runtimeVersion = flagStr(args, 'runtime-version');
  if (!runtimeVersion || runtimeVersion === 'auto') {
    const project = flagStr(args, 'project', process.cwd());
    runtimeVersion = fingerprintProject(project).runtimeVersion;
    console.log(`runtimeVersion (auto): ${runtimeVersion}`);
  }

  const bundleVersion = Number.parseInt(flagStr(args, 'bundle-version') || (interactive ? await ask('bundleVersion (integer)', '1') : '1'), 10);
  if (!Number.isInteger(bundleVersion)) throw new Error('--bundle-version must be an integer');

  const mandatory = flagBool(args, 'mandatory') || (interactive ? await askYesNo('mandatory update?', false) : false);
  const targetAppVersions = flagStr(args, 'target-app-versions') || (interactive ? await ask('targetAppVersions (blank = any)', '') : '');
  const rollout = Number.parseInt(flagStr(args, 'rollout') || (interactive ? await ask('rollout %', '100') : '100'), 10);

  let releaseNotes = flagStr(args, 'release-note');
  if (!releaseNotes && interactive) releaseNotes = await askMultiline('Release notes');

  const keyId = flagStr(args, 'key-id', 'key_dev_1');
  const keyPath = flagStr(args, 'key', join('.keys', `${keyId}.private.pem`));
  if (!existsSync(keyPath)) throw new Error(`signing key not found: ${keyPath} (run: dash-ota keygen)`);
  const privateKeyPem = readFileSync(keyPath, 'utf8');

  const bundleId = flagStr(args, 'bundle-id', `bnd_${runtimeVersion}_${bundleVersion}_${Date.now().toString(36)}`);

  const built = buildRelease({
    bundleId,
    runtimeVersion,
    bundleVersion,
    platform,
    channel,
    mandatory,
    files,
    keyId,
    ...(targetAppVersions ? { targetAppVersions } : {}),
    ...(releaseNotes ? { releaseNotes } : {}),
  });
  const signed = signManifest(built.manifest, privateKeyPem);

  console.log(`\n  bundleId:        ${bundleId}`);
  console.log(`  runtimeVersion:  ${runtimeVersion}   bundleVersion: ${bundleVersion}`);
  console.log(`  files:           ${files.length}   ciphertext: ${built.ciphertext.length} bytes   rollout: ${rollout}%`);

  if (flagBool(args, 'no-upload')) {
    const outFile = join(bundleDir, '..', `${bundleId}.signed.json`);
    writeFileSync(outFile, JSON.stringify({ signedManifest: signed, ciphertextB64: built.ciphertext.toString('base64') }, null, 2));
    console.log(`✓ wrote artifact (not uploaded): ${outFile}`);
    return;
  }
  const { server, adminToken } = resolveServer(args);
  const res = await adminPost(server, '/admin/publish', { signedManifest: signed, ciphertextB64: built.ciphertext.toString('base64'), rolloutPercentage: rollout }, adminToken);
  console.log(`✓ published to ${server}:`, JSON.stringify(res));
}

/** List releases + adoption. */
async function cmdList(args: ParsedArgs): Promise<void> {
  const { server, adminToken } = resolveServer(args);
  const data = (await adminGet(server, '/admin/releases', adminToken)) as {
    releases: { bundleId: string; channel: string; platform: string; runtimeVersion: string; bundleVersion: number; rolloutPercentage: number; paused: boolean; rolledBack: boolean; adoption: Record<string, number> }[];
  };
  if (data.releases.length === 0) {
    console.log('(no releases)');
    return;
  }
  for (const r of data.releases) {
    const state = r.rolledBack ? 'ROLLED_BACK' : r.paused ? 'PAUSED' : `${r.rolloutPercentage}%`;
    console.log(`${r.bundleId}  [${r.platform}/${r.channel}]  rt=${r.runtimeVersion} v${r.bundleVersion}  ${state}  adoption=${JSON.stringify(r.adoption)}`);
  }
}

async function cmdRollout(args: ParsedArgs): Promise<void> {
  const { server, adminToken } = resolveServer(args);
  await adminPost(server, '/admin/rollout', { bundleId: flagStr(args, 'bundle-id'), rolloutPercentage: Number.parseInt(flagStr(args, 'pct', '100'), 10) }, adminToken);
  console.log('✓ rollout updated');
}
async function cmdPause(args: ParsedArgs): Promise<void> {
  const { server, adminToken } = resolveServer(args);
  await adminPost(server, '/admin/pause', { bundleId: flagStr(args, 'bundle-id'), paused: !flagBool(args, 'resume') }, adminToken);
  console.log('✓ pause state updated');
}
async function cmdRollback(args: ParsedArgs): Promise<void> {
  const { server, adminToken } = resolveServer(args);
  await adminPost(server, '/admin/rollback', { bundleId: flagStr(args, 'bundle-id') }, adminToken);
  console.log('✓ release rolled back (paused + flagged)');
}
async function cmdNativePolicy(args: ParsedArgs): Promise<void> {
  const { server, adminToken } = resolveServer(args);
  await adminPost(server, '/admin/native-policy', {
    channel: asChannel(flagStr(args, 'channel', 'dev')),
    minSupportedNativeVersion: Number.parseInt(flagStr(args, 'min', '0'), 10),
    severity: flagStr(args, 'severity', 'hard'),
    storeUrl: flagStr(args, 'store-url') || undefined,
  }, adminToken);
  console.log('✓ native policy updated');
}

function printHelp(): void {
  console.log(`dash-ota <command> [flags]

  keygen          --out .keys --key-id key_dev_1 [--server --admin-token]
  register-key    --key-id <id> (--pub <rawB64> | --key-file <.public.json>)
  fingerprint     --project <path>
  bundle          --project <path> --platform ios|android --out <dir> [--dev]
  publish         --bundle-dir <dir> --platform --channel --runtime-version auto|<R>
                  --bundle-version <n> [--mandatory] [--target-app-versions <range>]
                  [--rollout <pct>] [--release-note <txt>] [--interactive] [--no-upload]
                  [--key <pem>] [--key-id <id>] [--server --admin-token]
  list            [--server --admin-token]
  rollout         --bundle-id <id> --pct <0-100>
  pause           --bundle-id <id> [--resume]
  rollback        --bundle-id <id>
  native-policy   --channel <c> --min <build> --severity soft|hard [--store-url <url>]
`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  switch (command) {
    case 'keygen': return cmdKeygen(args);
    case 'register-key': return cmdRegisterKey(args);
    case 'fingerprint': return cmdFingerprint(args);
    case 'bundle': return cmdBundle(args);
    case 'publish': return cmdPublish(args);
    case 'list': return cmdList(args);
    case 'rollout': return cmdRollout(args);
    case 'pause': return cmdPause(args);
    case 'rollback': return cmdRollback(args);
    case 'native-policy': return cmdNativePolicy(args);
    default:
      printHelp();
      if (command && command !== 'help') process.exitCode = 1;
  }
}

void main().catch((err: unknown) => {
  console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
