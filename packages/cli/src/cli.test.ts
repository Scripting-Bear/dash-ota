/**
 * CLI unit tests — the release trust root. Covers arg parsing, the secure-server / fail-closed
 * admin guards, the passphrase key-custody roundtrip (encrypt → decrypt → sign → verify), and the
 * content-hash runtimeVersion fingerprint (incl. the same-size-different-content case that the old
 * path+size hash missed). Pure/offline — no server, no network. Run: `npm run test:cli`.
 *
 * @module cli.test
 */

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildReleaseV2, generateSigningKeyPair, publicKeyFromRawB64, signManifest, verifyManifest } from '@dash-ota/shared';
import { hermescCandidates, prepareRelease, releaseState, resolveHermesc } from './core.js';
import { assertFlagValues, formatCommandHelp, formatGlobalHelp, isCommand } from './usage.js';
import {
  acceptedFlags,
  assertKnownFlags,
  assertSecureServer,
  decryptPrivateKeyPem,
  encryptPrivateKeyPem,
  fingerprintProject,
  flagBool,
  flagInt,
  flagStr,
  isEncryptedPem,
  parseArgs,
  parseIntStrict,
  readBundleDir,
  resolveServer,
  resolveVerifyKey,
  verifyKeyFromPath,
} from './util.js';

const CLI_ENTRY = join(dirname(fileURLToPath(import.meta.url)), 'index.ts');

/** Run the CLI source in a child with stdin closed, as CI does. */
function runCli(args: string[], env: Record<string, string> = {}): { status: number; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [...process.execArgv, CLI_ENTRY, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, OTA_ADMIN_TOKEN: '', OTA_KEY_PASSPHRASE: '', ...env },
  });
  return { status: res.status ?? -1, stdout: res.stdout, stderr: res.stderr };
}

/** A fixture's runtimeVersion as computed before git-tracked fingerprinting; a clean tree must keep it. */
const FIXTURE_RUNTIME_VERSION = 'af10b7910f454219';

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

/** Fixed content key for the fixtures. Real channels hold one of these; tests must not randomise it. */
const TEST_CONTENT_KEY = Buffer.alloc(32, 7);

let passed = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

/** Write a minimal fake RN project under a fresh temp dir; returns its path. */
function fakeProject(androidContent: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'dash-ota-cli-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { 'react-native': '0.79.2' } }));
  mkdirSync(join(dir, 'android', 'app'), { recursive: true });
  mkdirSync(join(dir, 'ios'), { recursive: true });
  writeFileSync(join(dir, 'android', 'app', 'build.gradle'), androidContent);
  writeFileSync(join(dir, 'ios', 'AppDelegate.mm'), 'ios-native');
  return dir;
}

async function main(): Promise<void> {
  console.log('dash-ota cli unit tests\n');

  await check('parseArgs handles positionals, --k v, --k=v, and bare flags', () => {
    const a = parseArgs(['publish', '--platform', 'ios', '--rollout=50', '--mandatory']);
    assert.equal(a._[0], 'publish');
    assert.equal(flagStr(a, 'platform'), 'ios');
    assert.equal(flagStr(a, 'rollout'), '50');
    assert.equal(flagBool(a, 'mandatory'), true);
    assert.equal(flagBool(a, 'missing'), false);
  });

  await check('assertSecureServer allows localhost/https, refuses remote http', () => {
    assertSecureServer('http://localhost:4455', false);
    assertSecureServer('http://127.0.0.1:4455', false);
    assertSecureServer('http://[::1]:4455', false); // IPv6 localhost (brackets stripped)
    assertSecureServer('https://ota.example.com', false);
    assertSecureServer('http://ota.example.com', true); // explicit escape hatch
    assert.throws(() => assertSecureServer('http://ota.example.com', false), /plaintext http/);
    assert.throws(() => assertSecureServer('http://localhost.evil.com', false), /plaintext http/); // not local
    assert.throws(() => assertSecureServer('not a url', false), /invalid --server/);
  });

  await check('resolveServer is fail-closed on the admin token (no default)', () => {
    const saved = process.env.OTA_ADMIN_TOKEN;
    delete process.env.OTA_ADMIN_TOKEN;
    try {
      assert.throws(() => resolveServer(parseArgs(['list'])), /admin token required/);
      const ok = resolveServer(parseArgs(['list', '--admin-token', 'secret', '--server', 'https://x.example.com']));
      assert.equal(ok.adminToken, 'secret');
    } finally {
      if (saved !== undefined) process.env.OTA_ADMIN_TOKEN = saved;
    }
  });

  await check('key custody: encrypt → decrypt → sign → verify roundtrip', async () => {
    const kp = generateSigningKeyPair();
    assert.equal(isEncryptedPem(kp.privateKeyPem), false);
    const enc = encryptPrivateKeyPem(kp.privateKeyPem, 'hunter2');
    assert.equal(isEncryptedPem(enc), true);
    const dec = decryptPrivateKeyPem(enc, 'hunter2');

    const { manifest } = await buildReleaseV2({
      contentKey: TEST_CONTENT_KEY,
      bundleId: 'bnd_cli',
      runtimeVersion: 'R2',
      bundleVersion: 1,
      platform: 'android',
      channel: 'dev',
      appId: 'com.example.app',
      mandatory: false,
      files: [{ path: 'index.android.bundle', data: Buffer.from('x=1', 'utf8') }],
      bundlePath: 'index.android.bundle',
      keyId: 'key_dev_1',
    });
    const signed = signManifest(manifest, dec);
    assert.ok(verifyManifest(signed, publicKeyFromRawB64(kp.publicKeyRawB64)), 'decrypted key must produce a valid signature');
    assert.throws(() => decryptPrivateKeyPem(enc, 'wrong-passphrase'));
  });

  await check('resolveVerifyKey: sibling .public.json, --verify-pub, and safe fallback (no crash)', async () => {
    const kp = generateSigningKeyPair();
    const dir = mkdtempSync(join(tmpdir(), 'dash-ota-verify-'));
    const keyPath = join(dir, 'key_dev_1.private.pem');
    writeFileSync(keyPath, kp.privateKeyPem);
    writeFileSync(
      join(dir, 'key_dev_1.public.json'),
      JSON.stringify({ keyId: 'key_dev_1', publicKeyRawB64: kp.publicKeyRawB64 }),
    );
    const { manifest } = await buildReleaseV2({
      contentKey: TEST_CONTENT_KEY,
      bundleId: 'bnd_v',
      runtimeVersion: 'R2',
      bundleVersion: 1,
      platform: 'android',
      channel: 'dev',
      appId: 'com.example.app',
      mandatory: false,
      files: [{ path: 'index.android.bundle', data: Buffer.from('x=1', 'utf8') }],
      bundlePath: 'index.android.bundle',
      keyId: 'key_dev_1',
    });
    const signed = signManifest(manifest, kp.privateKeyPem);

    const viaSibling = resolveVerifyKey(parseArgs([]), keyPath, kp.privateKeyPem);
    assert.match(viaSibling.source, /public\.json$/);
    assert.ok(verifyManifest(signed, viaSibling.key));

    const viaFlag = resolveVerifyKey(parseArgs(['--verify-pub', kp.publicKeyRawB64]), keyPath, kp.privateKeyPem);
    assert.equal(viaFlag.source, '--verify-pub');
    assert.ok(verifyManifest(signed, viaFlag.key));

    // custom --key path NOT ending in .private.pem, no sibling → safe fallback, must not crash
    const custom = join(dir, 'mykey.pem');
    writeFileSync(custom, kp.privateKeyPem);
    const viaFallback = resolveVerifyKey(parseArgs([]), custom, kp.privateKeyPem);
    assert.match(viaFallback.source, /consistency check/);
    assert.ok(verifyManifest(signed, viaFallback.key));
  });

  await check('readBundleDir reads files with POSIX relative paths', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dash-ota-bundle-'));
    mkdirSync(join(dir, 'assets'), { recursive: true });
    writeFileSync(join(dir, 'index.android.bundle'), 'BUNDLE');
    writeFileSync(join(dir, 'assets', 'logo.txt'), 'LOGO');
    const files = readBundleDir(dir);
    assert.equal(files.length, 2);
    assert.ok(files.some((f) => f.path === 'assets/logo.txt'));
  });

  await check('fingerprint is deterministic and content-sensitive (same size, different bytes)', () => {
    const p1 = fakeProject('AAAA');
    const p2 = fakeProject('AAAA');
    const p3 = fakeProject('BBBB'); // same length as AAAA — the case the old path+size hash missed
    const rv1 = fingerprintProject(p1).runtimeVersion;
    const rv2 = fingerprintProject(p2).runtimeVersion;
    const rv3 = fingerprintProject(p3).runtimeVersion;
    assert.equal(rv1, rv2, 'identical projects → identical runtimeVersion');
    assert.notEqual(rv1, rv3, 'a same-size content change MUST flip the runtimeVersion');
  });

  await check('fingerprint of a clean tree is unchanged: the pre-git walk value, in and out of git', () => {
    assert.equal(fingerprintProject(fakeProject('AAAA')).runtimeVersion, FIXTURE_RUNTIME_VERSION);
    const repo = fakeProject('AAAA');
    git(repo, 'init', '-q');
    git(repo, 'add', '-A');
    const tracked = fingerprintProject(repo);
    assert.equal(tracked.runtimeVersion, FIXTURE_RUNTIME_VERSION);
    assert.deepEqual(tracked.nativeSources, { android: 'git', ios: 'git' });
  });

  await check('fingerprint ignores untracked local files in git, and machine-local files outside it', () => {
    const addLocalFiles = (dir: string): void => {
      writeFileSync(join(dir, 'android', 'local.properties'), 'sdk.dir=/Users/me/Library/Android/sdk');
      writeFileSync(join(dir, 'ios', '.xcode.env.local'), 'export NODE_BINARY=/opt/homebrew/bin/node');
      writeFileSync(join(dir, 'android', '.DS_Store'), 'x');
      writeFileSync(join(dir, 'android', 'app', 'app.iml'), 'x');
      mkdirSync(join(dir, 'ios', 'App.xcodeproj', 'xcuserdata', 'me.xcuserdatad'), { recursive: true });
      writeFileSync(join(dir, 'ios', 'App.xcodeproj', 'xcuserdata', 'me.xcuserdatad', 'UserInterfaceState.xcuserstate'), 'x');
      writeFileSync(join(dir, 'ios', 'main.jsbundle'), 'x');
      mkdirSync(join(dir, 'android', '.kotlin'), { recursive: true });
      writeFileSync(join(dir, 'android', '.kotlin', 'session'), 'x');
    };

    const repo = fakeProject('AAAA');
    git(repo, 'init', '-q');
    git(repo, 'add', '-A');
    addLocalFiles(repo);
    // Untracked files never count in git, whatever they are called.
    writeFileSync(join(repo, 'android', 'app', 'Untracked.kt'), 'class Untracked');
    assert.equal(fingerprintProject(repo).runtimeVersion, FIXTURE_RUNTIME_VERSION);
    // A tracked file still counts, committed or not.
    writeFileSync(join(repo, 'android', 'app', 'build.gradle'), 'BBBB');
    assert.notEqual(fingerprintProject(repo).runtimeVersion, FIXTURE_RUNTIME_VERSION);

    const plain = fakeProject('AAAA');
    addLocalFiles(plain);
    assert.equal(fingerprintProject(plain).runtimeVersion, FIXTURE_RUNTIME_VERSION);
    assert.deepEqual(fingerprintProject(plain).nativeSources, { android: 'disk', ios: 'disk' });
  });

  await check('fingerprint walks a native folder git ignores entirely (generated by prebuild)', () => {
    const repo = fakeProject('AAAA');
    writeFileSync(join(repo, '.gitignore'), 'android/\nios/\n');
    git(repo, 'init', '-q');
    git(repo, 'add', '-A');
    const result = fingerprintProject(repo);
    assert.equal(result.runtimeVersion, FIXTURE_RUNTIME_VERSION);
    assert.deepEqual(result.nativeSources, { android: 'disk', ios: 'disk' });
  });

  await check('unknown flags are refused, so a typo cannot silently take a default', () => {
    // The real footgun: `rollout` reads --pct (default 100), so --rollout 50 used to ramp to 100%.
    assert.throws(
      () => assertKnownFlags('rollout', parseArgs(['--bundle-id', 'b1', '--rollout', '50'])),
      /unknown flag for `rollout`[\s\S]*did you mean --pct/,
    );
    assert.throws(() => assertKnownFlags('publish', parseArgs(['--pct', '50'])), /did you mean --rollout/);
    assert.throws(() => assertKnownFlags('publish', parseArgs(['--bundle-dirr', './out'])), /did you mean --bundle-dir/);

    // Valid flags, including the shared server ones, must still pass.
    assertKnownFlags('rollout', parseArgs(['--bundle-id', 'b1', '--pct', '50', '--server', 'https://x.dev']));
    assertKnownFlags('publish', parseArgs(['--bundle-dir', './out', '--rollout', '10', '--mandatory']));
    assertKnownFlags('dashboard', parseArgs(['--port', '4460', '--no-open']));
    // A command with no declared flag set is left alone rather than guessed at.
    assertKnownFlags('help', parseArgs(['--whatever']));
  });

  await check('a value-taking flag with no value fails and names the flag', () => {
    // QA: `rollout --pct` moved a release to 100%, and `--rollout --release-note x` published at 100%.
    assert.throws(() => assertFlagValues('rollout', parseArgs(['--bundle-id', 'b1', '--pct'])), /--pct needs a value/);
    assert.throws(
      () => assertFlagValues('publish', parseArgs(['--bundle-dir', 'out', '--rollout', '--release-note', 'canary'])),
      /--rollout needs a value/,
    );
    assert.throws(() => assertFlagValues('publish', parseArgs(['--bundle-dir=out', '--app-id'])), /--app-id needs a value/);
    assert.throws(() => assertFlagValues('publish', parseArgs(['--mandatory', 'yes'])), /--mandatory is a switch/);
    assertFlagValues('publish', parseArgs(['--bundle-dir', 'out', '--rollout', '10', '--mandatory', '--release-note', 'x']));
    assertFlagValues('publish', parseArgs(['--mandatory', 'false', '--no-encrypt=true']));
  });

  await check('numeric flags accept whole numbers in range only', () => {
    for (const bad of ['2.5.0', '42abc', '1e3', '', 'abc', '0x10', '1.0']) {
      assert.throws(() => parseIntStrict(bad, '--min', 0, 100), /--min must be a whole number from 0 to 100/, bad);
    }
    assert.equal(parseIntStrict('42', '--min', 0, 100), 42);
    assert.equal(parseIntStrict(' 7 ', '--min', 0, 100), 7);
    const level = (v: string): number | undefined => flagInt(parseArgs(['--compression-level', v]), 'compression-level', 1, 22);
    for (const bad of ['0', 'abc', '23', '99', '-1']) assert.throws(() => level(bad), /--compression-level must be/, bad);
    assert.equal(level('1'), 1);
    assert.equal(level('22'), 22);
    assert.equal(flagInt(parseArgs([]), 'pct', 0, 100), undefined);
    assert.throws(() => flagInt(parseArgs(['--pct', '101']), 'pct', 0, 100), /--pct must be a whole number from 0 to 100/);
  });

  await check('every command documents every flag it accepts, with the defaults that apply', () => {
    for (const command of [
      'keygen',
      'register-key',
      'fingerprint',
      'bundle',
      'publish',
      'list',
      'rollout',
      'pause',
      'rollback',
      'native-policy',
      'dashboard',
    ]) {
      assert.ok(isCommand(command), command);
      const help = formatCommandHelp(command);
      for (const flag of acceptedFlags(command) ?? []) assert.ok(help.includes(`--${flag}`), `${command} help lacks --${flag}`);
      assert.ok(formatGlobalHelp().includes(`  ${command} `), `global help lacks ${command}`);
    }
    // Flags QA found missing from the help.
    assert.match(formatCommandHelp('bundle'), /--entry <file>/);
    const publish = formatCommandHelp('publish');
    for (const flag of ['--project', '--allow-insecure', '--bundle-id', '--min-native-build <n>'])
      assert.ok(publish.includes(flag), flag);
    assert.match(formatCommandHelp('keygen'), /--content-key-only[\s\S]*--force/);
    assert.match(publish, /required:\n {2}--bundle-dir <dir>[^\n]*\n {2}--app-id <id>/);
    for (const d of [/--platform ios\|android .*\(default: android\)/, /--channel dev\|uat\|prod .*\(default: dev\)/])
      assert.match(publish, d);
    for (const d of [/--bundle-version <n> .*\(default: 1\)/, /--key-id <id> .*\(default: key_dev_1\)/]) assert.match(publish, d);
    const policy = formatCommandHelp('native-policy');
    for (const d of [/--channel .*\(default: dev\)/, /--min <build> .*\(default: 0\)/, /--severity .*\(default: hard\)/]) {
      assert.match(policy, d);
    }
    assert.match(formatCommandHelp('fingerprint'), /including\s+a JS-only one/);
    assert.equal(isCommand('constructor'), false);
    assert.equal(isCommand('bogus'), false);
  });

  await check('--min-native-build is accepted and lands in the signed manifest', async () => {
    assertKnownFlags('publish', parseArgs(['--bundle-dir', 'out', '--min-native-build', '42']));
    const kp = generateSigningKeyPair();
    const dir = mkdtempSync(join(tmpdir(), 'dash-ota-minbuild-'));
    const keyPath = join(dir, 'k.private.pem');
    writeFileSync(keyPath, kp.privateKeyPem);
    const prepared = await prepareRelease({
      files: [{ path: 'index.android.bundle', data: Buffer.from('x=1') }],
      platform: 'android',
      channel: 'dev',
      runtimeVersion: 'R2',
      bundleVersion: 1,
      appId: 'com.example.app',
      mandatory: false,
      keyId: 'k',
      privateKeyPem: kp.privateKeyPem,
      encrypt: true,
      contentKey: TEST_CONTENT_KEY,
      verifyKey: verifyKeyFromPath(keyPath, kp.privateKeyPem),
      minNativeBuild: 42,
    });
    assert.equal(prepared.signed.manifest.minNativeBuild, 42);
    assert.ok(verifyManifest(prepared.signed, publicKeyFromRawB64(kp.publicKeyRawB64)));
  });

  await check('list shows an unfinalized release as INCOMPLETE, with no rollout', () => {
    assert.equal(releaseState({ finalized: false, rolledBack: false, paused: false, rolloutPercentage: 100 }), 'INCOMPLETE');
    assert.equal(releaseState({ finalized: false, rolledBack: false, paused: true, rolloutPercentage: 10 }), 'INCOMPLETE');
    assert.equal(releaseState({ finalized: true, rolledBack: false, paused: false, rolloutPercentage: 10 }), '10%');
    // Backends before protocol 2 do not send the field and list finished releases only.
    assert.equal(releaseState({ rolledBack: false, paused: false, rolloutPercentage: 25 }), '25%');
    assert.equal(releaseState({ finalized: true, rolledBack: true, paused: true, rolloutPercentage: 25 }), 'ROLLED_BACK');
  });

  await check('hermesc is found in either layout, preferring the one react-native depends on', () => {
    const bin =
      process.platform === 'darwin'
        ? 'osx-bin/hermesc'
        : process.platform === 'win32'
          ? 'win64-bin/hermesc.exe'
          : 'linux64-bin/hermesc';
    const app = (rnDeps: Record<string, string>, layouts: ('legacy' | 'compiler')[]): string => {
      // realpath: module resolution reports /private/var for macOS's /var temp folders.
      const dir = realpathSync(mkdtempSync(join(tmpdir(), 'dash-ota-hermesc-')));
      writeFileSync(join(dir, 'package.json'), '{}');
      const rn = join(dir, 'node_modules', 'react-native');
      mkdirSync(rn, { recursive: true });
      writeFileSync(join(rn, 'package.json'), JSON.stringify({ name: 'react-native', dependencies: rnDeps }));
      const place = (path: string): void => {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, '');
        chmodSync(path, 0o755);
      };
      if (layouts.includes('legacy')) place(join(rn, 'sdks', 'hermesc', bin));
      if (layouts.includes('compiler')) {
        const compiler = join(dir, 'node_modules', 'hermes-compiler');
        mkdirSync(compiler, { recursive: true });
        writeFileSync(join(compiler, 'package.json'), JSON.stringify({ name: 'hermes-compiler' }));
        place(join(compiler, 'hermesc', bin));
      }
      return dir;
    };
    const legacyPath = (dir: string): string => join(dir, 'node_modules', 'react-native', 'sdks', 'hermesc', bin);
    const compilerPath = (dir: string): string => join(dir, 'node_modules', 'hermes-compiler', 'hermesc', bin);

    const rn087 = app({ 'hermes-compiler': '250829098.0.17' }, ['compiler']);
    assert.equal(resolveHermesc(rn087), compilerPath(rn087));
    const rn079 = app({}, ['legacy']);
    assert.equal(resolveHermesc(rn079), legacyPath(rn079));
    const both = app({ 'hermes-compiler': '250829098.0.17' }, ['legacy', 'compiler']);
    assert.equal(resolveHermesc(both), compilerPath(both));
    const bothOld = app({}, ['legacy', 'compiler']);
    assert.equal(resolveHermesc(bothOld), legacyPath(bothOld));

    const none = app({ 'hermes-compiler': '250829098.0.17' }, []);
    assert.equal(resolveHermesc(none), null);
    assert.deepEqual(hermescCandidates(none), [compilerPath(none), legacyPath(none)]);
  });

  await check('--server with a trailing slash still reaches /admin/...', () => {
    const { server } = resolveServer(parseArgs(['list', '--admin-token', 't', '--server', 'https://ota.example.com//']));
    assert.equal(server, 'https://ota.example.com');
  });

  await check('keygen without a terminal never prompts: it needs a passphrase or --no-encrypt', () => {
    const work = mkdtempSync(join(tmpdir(), 'dash-ota-keygen-tty-'));
    const refused = runCli(['keygen', '--out', join(work, 'a'), '--key-id', 'k']);
    assert.equal(refused.status, 1, refused.stdout + refused.stderr);
    assert.match(refused.stderr, /--passphrase <p> or set OTA_KEY_PASSPHRASE[\s\S]*--no-encrypt/);
    assert.ok(!refused.stdout.includes('Passphrase to encrypt'), 'it prompted');
    assert.ok(!existsSync(join(work, 'a')), 'it wrote key files');

    const viaEnv = runCli(['keygen', '--out', join(work, 'b'), '--key-id', 'k'], { OTA_KEY_PASSPHRASE: 'hunter2' });
    assert.equal(viaEnv.status, 0, viaEnv.stderr);
    assert.ok(readdirSync(join(work, 'b')).includes('k.private.pem'));
    assert.match(viaEnv.stdout, /encrypted at rest/);

    const registerless = runCli(['keygen', '--out', join(work, 'c'), '--key-id', 'k', '--no-encrypt', '--register']);
    assert.equal(registerless.status, 1);
    assert.match(registerless.stderr, /admin token required/);
    assert.ok(!existsSync(join(work, 'c')), '--register without a token must fail before writing a key');
  });

  await check('`<command> --help` and -h print that command, exit 0; an unknown command exits 1', () => {
    for (const args of [
      ['publish', '--help'],
      ['rollout', '-h'],
      ['help', 'publish'],
      ['publish', '--bundle-dir', '--help'],
    ]) {
      const res = runCli(args);
      assert.equal(res.status, 0, `${args.join(' ')}: ${res.stderr}`);
      assert.match(res.stdout, new RegExp(`usage: dash-ota ${args[0] === 'help' ? 'publish' : args[0]} `));
    }
    const unknown = runCli(['publsh']);
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /^✗ unknown command "publsh"/);
    assert.equal(runCli(['--help']).status, 0);
  });

  await check('bad flag values fail with exit 1 before anything reaches a server', () => {
    const cases: [string[], RegExp][] = [
      [['rollout', '--bundle-id', 'b1', '--pct'], /--pct needs a value/],
      [['native-policy', '--min', '2.5.0'], /--min must be a whole number/],
      [['native-policy', '--min', '42abc'], /--min must be a whole number/],
      [['publish', '--bundle-dir', 'out', '--app-id', 'a', '--compression-level', '0'], /--compression-level must be/],
      [['publish', '--bundle-dir', 'out', '--app-id', 'a', '--rollout', '--release-note', 'canary'], /--rollout needs a value/],
    ];
    for (const [args, message] of cases) {
      const res = runCli([...args, '--server', 'http://127.0.0.1:9', '--admin-token', 't']);
      assert.equal(res.status, 1, args.join(' '));
      assert.match(res.stderr, message, args.join(' '));
    }
  });

  console.log(`\n${passed} cli checks passed.`);
}

void main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
