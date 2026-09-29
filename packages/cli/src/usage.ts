/**
 * What `dash-ota --help` and `dash-ota <command> --help` print, and which flags take a value.
 *
 * The accepted flag set lives in `KNOWN_FLAGS` (util.ts), which the docs checker reads; every flag
 * there needs an entry here, and {@link formatCommandHelp} throws when one is missing.
 *
 * @module usage
 */

import { acceptedFlags, type ParsedArgs } from './util.js';

/** One flag in a command's help. A flag without `value` is a switch. */
interface FlagUsage {
  /** Placeholder for the value, e.g. `<dir>`. */
  value?: string;
  required?: boolean;
  default?: string;
  help: string;
}

interface CommandUsage {
  summary: string;
  flags: Record<string, FlagUsage>;
  notes?: string[];
}

const SERVER: Record<string, FlagUsage> = {
  server: { value: '<url>', default: '$OTA_SERVER, else http://localhost:4455', help: 'backend base URL' },
  'admin-token': { value: '<token>', default: '$OTA_ADMIN_TOKEN', help: 'admin credential, required for server calls' },
  'allow-insecure': { help: 'allow plaintext http:// to a host other than localhost' },
};

const HELP: Record<string, FlagUsage> = { help: { help: 'print this help (also -h)' } };

const PROJECT: FlagUsage = { value: '<path>', default: 'the current directory', help: 'React Native app root' };
const PLATFORM: FlagUsage = { value: 'ios|android', default: 'android', help: 'target platform' };
const BUNDLE_ID: FlagUsage = { value: '<id>', required: true, help: 'the release, as `dash-ota list` shows it' };

const COMMAND_USAGE: Record<string, CommandUsage> = {
  keygen: {
    summary: 'Generate an Ed25519 signing keypair and the channel content key.',
    flags: {
      out: { value: '<dir>', default: '.keys', help: 'where the key files are written' },
      'key-id': { value: '<id>', default: 'key_dev_1', help: 'names the files and the manifest keyId' },
      passphrase: {
        value: '<passphrase>',
        default: '$OTA_KEY_PASSPHRASE, else a prompt on a terminal',
        help: 'encrypts the private key at rest',
      },
      'no-encrypt': { help: 'store the private key unencrypted' },
      'content-key-only': { help: 'only add a missing <key-id>.content.key beside an existing signing key' },
      force: { help: 'replace an existing signing key; apps embedding the old public key reject every later release' },
      register: { help: 'register the new public key with the backend' },
      interactive: { help: 'ask whether to register the key' },
      ...SERVER,
      ...HELP,
    },
    notes: ['Without a terminal there is no prompt: give --passphrase or OTA_KEY_PASSPHRASE, or --no-encrypt.'],
  },
  'register-key': {
    summary: 'Tell the backend to trust a public key.',
    flags: {
      'key-id': { value: '<id>', default: 'key_dev_1', help: 'key id the manifests carry' },
      pub: { value: '<rawB64>', help: 'the public key, raw base64; this or --key-file is required' },
      'key-file': { value: '<path>', help: 'the <key-id>.public.json written by keygen' },
      ...SERVER,
      ...HELP,
    },
  },
  fingerprint: {
    summary: "Print the project's runtimeVersion: which native builds a release can run on.",
    flags: { project: PROJECT, ...HELP },
    notes: [
      'Hashes every dependency in package.json (name and version spec), the React Native and Hermes',
      'versions, and the files under android/ and ios/. Any dependency change changes it, including',
      'a JS-only one. In a git work tree only files git tracks under android/ and ios/ count, so',
      'untracked local files such as local.properties or .xcode.env.local do not; outside git, build',
      'output and those machine-local files are skipped.',
    ],
  },
  bundle: {
    summary: 'Run `react-native bundle` into a payload directory, optionally compiled to Hermes bytecode.',
    flags: {
      project: PROJECT,
      platform: PLATFORM,
      out: { value: '<dir>', default: '<project>/.dash-ota-bundle/<platform>', help: 'payload directory for publish' },
      entry: { value: '<file>', default: 'index.js', help: 'JS entry file, relative to --project' },
      dev: { help: 'build a development bundle' },
      hermes: { help: "compile to Hermes bytecode with the app's own hermesc; fails if there is none" },
      ...HELP,
    },
    notes: [
      'Keep --out the same for every release. The server stores each distinct file once, and a compiler',
      'that records its output path (hermesc given an absolute path) turns the same source into new',
      'bytes in a new folder. --hermes compiles with a relative path, so its output does not depend on it.',
      'hermesc comes from react-native/sdks/hermesc (React Native 0.82 and older) or from the',
      'hermes-compiler package (0.83 and later).',
    ],
  },
  publish: {
    summary: 'Compress, encrypt and sign a bundle directory, then upload only the files the server lacks.',
    flags: {
      'bundle-dir': { value: '<dir>', required: true, help: 'payload directory written by `dash-ota bundle`' },
      'app-id': { value: '<id>', required: true, help: 'package name / bundle id; devices refuse a release for another app' },
      platform: PLATFORM,
      channel: { value: 'dev|uat|prod', default: 'dev', help: 'release channel' },
      'runtime-version': {
        value: 'auto|<value>',
        default: 'auto',
        help: 'auto fingerprints --project; see `dash-ota fingerprint --help`',
      },
      project: { ...PROJECT, help: 'app root that --runtime-version auto fingerprints' },
      'bundle-version': { value: '<n>', default: '1', help: 'must be higher than the last release on this channel and platform' },
      'min-native-build': { value: '<n>', help: 'devices on a lower native build number skip this release' },
      mandatory: { help: 'devices download and apply it without asking' },
      'target-app-versions': { value: '<range>', help: 'semver range over the app version, e.g. ">=1.2.0 <1.3.0"' },
      rollout: { value: '<0-100>', default: '100', help: 'percentage of devices offered the release' },
      'release-note': { value: '<text>', help: '"What\'s new" text' },
      'bundle-id': { value: '<id>', default: 'bnd_<runtime>_<version>_<time>, new on every run', help: 'release id' },
      key: { value: '<path>', default: '.keys/<key-id>.private.pem', help: 'signing key' },
      'key-id': { value: '<id>', default: 'key_dev_1', help: 'signing key id, registered with the backend' },
      passphrase: { value: '<passphrase>', default: '$OTA_KEY_PASSPHRASE', help: 'decrypts an encrypted signing key' },
      'verify-pub': {
        value: '<rawB64>',
        default: '<key-id>.public.json beside --key',
        help: 'public key the signature is checked against before upload',
      },
      'content-key': {
        value: '<base64>',
        default: '$OTA_CONTENT_KEY, else <key dir>/<key-id>.content.key',
        help: 'channel content key',
      },
      'no-encrypt': { help: 'store compressed plaintext; files are still hash-checked' },
      'compression-level': { value: '<1-22>', default: '19', help: 'zstd level for the JS bundle' },
      'no-upload': { help: 'write the signed release next to --bundle-dir instead of uploading it' },
      interactive: { help: 'prompt for anything not given' },
      ...SERVER,
      ...HELP,
    },
    notes: [
      'Without --bundle-id every run creates a new release, so re-running an interrupted publish leaves',
      'the first attempt in `dash-ota list` as INCOMPLETE.',
    ],
  },
  list: {
    summary: 'List releases with their rollout state and adoption.',
    flags: { ...SERVER, ...HELP },
    notes: ['INCOMPLETE: declared but never finalized (an interrupted publish). Devices are never offered it.'],
  },
  rollout: {
    summary: 'Change the percentage of devices a release is offered to.',
    flags: {
      'bundle-id': BUNDLE_ID,
      pct: { value: '<0-100>', default: '100', help: 'new rollout percentage' },
      ...SERVER,
      ...HELP,
    },
  },
  pause: {
    summary: 'Stop offering a release, or resume it.',
    flags: { 'bundle-id': BUNDLE_ID, resume: { help: 'resume instead of pausing' }, ...SERVER, ...HELP },
  },
  rollback: {
    summary: 'Pause a release and flag it rolled back. One-way: nothing clears the flag.',
    flags: { 'bundle-id': BUNDLE_ID, ...SERVER, ...HELP },
  },
  'native-policy': {
    summary: "Set a channel's force-update gate for native builds below a minimum.",
    flags: {
      channel: { value: 'dev|uat|prod', default: 'dev', help: 'channel the policy applies to' },
      min: { value: '<build>', default: '0', help: 'lowest native build number still supported' },
      severity: {
        value: 'soft|hard',
        default: 'hard',
        help: 'what devices below --min are told; the app decides what soft and hard look like',
      },
      'store-url': {
        value: '<url>',
        help: 'store link sent with the policy; clients from 0.5.0 use their own config.storeUrl instead',
      },
      ...SERVER,
      ...HELP,
    },
  },
  dashboard: {
    summary: 'Serve a local web UI for the commands above, on 127.0.0.1 only.',
    flags: {
      config: { value: '<path>', default: 'dash-ota.config.mjs', help: 'environments file' },
      port: { value: '<n>', default: '4460', help: 'port on 127.0.0.1; 0 picks a free one' },
      'no-open': { help: 'print the link without opening a browser' },
      ...HELP,
    },
  },
};

const GLOBAL_NOTES = `  Wire format: protocol 2 — one content-addressed blob per distinct file, compressed with zstd
  and (unless --no-encrypt) encrypted with the channel content key. Publishing uploads only the
  blobs the server is missing; a device downloads only the files it does not already hold.
  --app-id is required: a device refuses a manifest built for a different app. Releases are
  immutable once finalized.

  Trust root: --admin-token (or OTA_ADMIN_TOKEN) is required for server calls — no default.
  Plaintext http:// to a remote host is refused (use https://, or --allow-insecure on a
  trusted network). Encrypted signing keys need a passphrase — prefer OTA_KEY_PASSPHRASE or the
  masked prompt over --passphrase (a CLI flag is visible in process listings / shell history).
`;

/** True for a command the CLI implements. */
export function isCommand(command: string): boolean {
  return Object.hasOwn(COMMAND_USAGE, command) && acceptedFlags(command) !== undefined;
}

/** `dash-ota --help`: every command with its summary. */
export function formatGlobalHelp(): string {
  const commands = Object.entries(COMMAND_USAGE).map(([name, usage]) => `  ${name.padEnd(15)} ${usage.summary}`);
  return [
    'usage: dash-ota <command> [flags]',
    '',
    ...commands,
    '',
    '  Run `dash-ota <command> --help` for its flags, which are required, and their defaults.',
    '',
    GLOBAL_NOTES,
  ].join('\n');
}

/**
 * `dash-ota <command> --help`: every flag the command accepts, required ones first, with defaults.
 *
 * @throws for an unknown command, or a flag in `KNOWN_FLAGS` with no entry here.
 */
export function formatCommandHelp(command: string): string {
  const accepted = acceptedFlags(command);
  if (!isCommand(command) || !accepted) throw new Error(`unknown command "${command}"`);
  const usage = COMMAND_USAGE[command] as CommandUsage;
  const rows = accepted.map((name) => {
    const flag = usage.flags[name];
    if (!flag) throw new Error(`\`${command}\` accepts --${name} but its help does not describe it`);
    const detail = flag.default ? `${flag.help} (default: ${flag.default})` : flag.help;
    return { flag, left: `--${name}${flag.value ? ` ${flag.value}` : ''}`, detail };
  });
  const width = Math.min(30, Math.max(...rows.map((r) => r.left.length)) + 2);
  const line = (r: (typeof rows)[number]): string =>
    r.left.length + 2 > width ? `  ${r.left}\n  ${' '.repeat(width)}${r.detail}` : `  ${r.left.padEnd(width)}${r.detail}`;
  const required = rows.filter((r) => r.flag.required);
  const optional = rows.filter((r) => !r.flag.required);
  return [
    `usage: ${['dash-ota', command, ...required.map((r) => r.left), '[flags]'].join(' ')}`,
    '',
    `  ${usage.summary}`,
    ...(required.length ? ['', 'required:', ...required.map(line)] : []),
    '',
    'flags:',
    ...optional.map(line),
    ...(usage.notes ? ['', ...usage.notes.map((n) => `  ${n}`)] : []),
    '',
  ].join('\n');
}

/**
 * Refuse a value-taking flag given no value, and a switch given one other than true/false.
 * Otherwise `--pct` alone, or `--rollout --release-note x`, parsed as a switch and the command
 * quietly used the default.
 *
 * @throws naming the first offending flag.
 */
export function assertFlagValues(command: string, args: ParsedArgs): void {
  if (!isCommand(command)) return;
  const usage = COMMAND_USAGE[command] as CommandUsage;
  for (const [name, value] of Object.entries(args.flags)) {
    const flag = usage.flags[name];
    if (!flag) continue;
    if (flag.value !== undefined && typeof value !== 'string') {
      throw new Error(`--${name} needs a value (--${name} ${flag.value})`);
    }
    if (flag.value === undefined && typeof value === 'string' && value !== 'true' && value !== 'false') {
      throw new Error(`--${name} is a switch and takes no value (got "${value}")`);
    }
  }
}
