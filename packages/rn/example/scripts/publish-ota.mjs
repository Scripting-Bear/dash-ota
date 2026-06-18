#!/usr/bin/env node
/**
 * Example OTA publish helper: bundles the example's JS for a flavour, compiles it to Hermes
 * bytecode (HBC) with the example's own `hermesc` (so it matches the installed binary's Hermes
 * — see plan C1), then publishes it through the dash-ota CLI to the matching channel.
 *
 * Usage:
 *   node scripts/publish-ota.mjs --platform android --channel dev --bundle-version 2 \
 *     --runtime-version rt1 --rollout 100 --release-note "what changed"
 *
 * Prereqs: the backend is running and the signing key is registered (see repo README).
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const exampleDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = join(exampleDir, '..', '..', '..'); // dash-ota monorepo root

/** Read a `--flag value` argument with a default. */
function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

/** Run a command, inheriting stdio; exit on failure. `quiet` pipes output and only prints on error. */
function run(cmd, args, cwd, quiet = false) {
  // hermesc dumps the whole bundle as a benign warning to stderr — give it a big buffer so
  // spawnSync doesn't ENOBUFS-kill it (which surfaces as a confusing "exit null").
  const res = spawnSync(cmd, args, { cwd, stdio: quiet ? 'pipe' : 'inherit', encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (res.status !== 0) {
    if (quiet) process.stderr.write(res.stderr ?? '');
    console.error(`\n✗ ${cmd} ${args.slice(0, 2).join(' ')} … failed (exit ${res.status})`);
    process.exit(res.status ?? 1);
  }
}

const platform = arg('platform', 'android');
const channel = arg('channel', 'dev');
const bundleVersion = arg('bundle-version', '1');
const runtimeVersion = arg('runtime-version', 'rt1');
const rollout = arg('rollout', '100');
const note = arg('release-note', `OTA ${channel} v${bundleVersion}`);
// Sign with the per-environment key (the CLI resolves .keys/<keyId>.private.pem). Defaults to dev.
const keyId = arg('key-id', channel === 'uat' ? 'key_uat' : channel === 'prod' ? 'key_prod' : 'key_dev_1');

const outDir = `/tmp/dash-ota-${platform}-${channel}-${bundleVersion}`;
const bundleName = platform === 'android' ? 'index.android.bundle' : 'main.jsbundle';
const bundlePath = join(outDir, bundleName);

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

console.log(`▸ bundling example JS (${platform})…`);
run('npx', ['react-native', 'bundle', '--platform', platform, '--dev', 'false', '--entry-file', 'index.js', '--bundle-output', bundlePath, '--assets-dest', outDir], exampleDir);

console.log('▸ compiling to Hermes bytecode…');
const hermesBin = process.platform === 'darwin' ? 'osx-bin' : process.platform === 'win32' ? 'win64-bin' : 'linux64-bin';
const hermesc = join(exampleDir, 'node_modules', 'react-native', 'sdks', 'hermesc', hermesBin, 'hermesc');
run(hermesc, ['-emit-binary', '-O', '-out', `${bundlePath}.hbc`, bundlePath], exampleDir, true);
renameSync(`${bundlePath}.hbc`, bundlePath);

console.log(`▸ publishing to ${channel} (rt=${runtimeVersion} v${bundleVersion})…`);
run('npx', ['tsx', 'packages/cli/src/index.ts', 'publish',
  '--bundle-dir', outDir,
  '--platform', platform,
  '--channel', channel,
  '--runtime-version', runtimeVersion,
  '--bundle-version', bundleVersion,
  '--rollout', rollout,
  '--key-id', keyId,
  '--release-note', note,
], repoRoot);

console.log('\n✓ done');
