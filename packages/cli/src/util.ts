/**
 * CLI utilities: arg parsing, interactive prompts (built-in readline — no deps), backend
 * admin API calls, recursive bundle-dir reading, and project runtimeVersion fingerprinting.
 *
 * @module util
 */

import { createHash, createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import * as readline from 'node:readline/promises';
import { Writable } from 'node:stream';
import { type ArchiveFile, computeRuntimeVersion, type FingerprintInputs, publicKeyFromRawB64 } from '@dash-ota/shared';

/** Parsed CLI args: positional `_` plus `--flag value` / `--bool` flags. */
export interface ParsedArgs {
  _: string[];
  flags: Record<string, string | boolean>;
}

/** True if a PKCS#8 PEM is passphrase-encrypted. */
export function isEncryptedPem(pem: string): boolean {
  return pem.includes('ENCRYPTED PRIVATE KEY');
}

/** Encrypt a PKCS#8 private-key PEM at rest with a passphrase (AES-256-CBC). */
export function encryptPrivateKeyPem(pem: string, passphrase: string): string {
  return createPrivateKey(pem).export({ type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase }).toString();
}

/**
 * Decrypt an encrypted PKCS#8 private-key PEM to plaintext PEM **in memory only** (for signing).
 * @throws if the passphrase is wrong / the key can't be decrypted
 */
export function decryptPrivateKeyPem(pem: string, passphrase: string): string {
  return createPrivateKey({ key: pem, passphrase }).export({ type: 'pkcs8', format: 'pem' }).toString();
}

/**
 * Resolve the public key to self-verify a freshly-signed manifest against, preferring the key the
 * app actually embeds: `--verify-pub <rawB64>`, else the sibling `<keyId>.public.json` next to the
 * signing key, else derive from the signing key (a consistency check only — can't catch a
 * wrong-key-vs-app mismatch). The sibling is only used when the key path actually ends in
 * `.private.pem` (so a custom `--key path.pem` never JSON-parses the private key by mistake).
 * @param privateKeyPem the **decrypted** signing key PEM (used for the fallback derivation)
 */
export function resolveVerifyKey(args: ParsedArgs, keyPath: string, privateKeyPem: string): { key: KeyObject; source: string } {
  const pubFlag = flagStr(args, 'verify-pub');
  if (pubFlag) return { key: publicKeyFromRawB64(pubFlag), source: '--verify-pub' };
  return verifyKeyFromPath(keyPath, privateKeyPem);
}

/** {@link resolveVerifyKey} without flags: the sibling `.public.json`, else derived from the signing key. */
export function verifyKeyFromPath(keyPath: string, privateKeyPem: string): { key: KeyObject; source: string } {
  const sibling = keyPath.replace(/\.private\.pem$/, '.public.json');
  if (sibling !== keyPath && existsSync(sibling)) {
    const raw = (JSON.parse(readFileSync(sibling, 'utf8')) as { publicKeyRawB64: string }).publicKeyRawB64;
    return { key: publicKeyFromRawB64(raw), source: sibling };
  }
  return { key: createPublicKey(createPrivateKey(privateKeyPem)), source: 'signing key (consistency check only)' };
}

/** Parse argv into positionals + flags (`--k v`, `--k=v`, `--bool`). */
export function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? '';
    if (!a.startsWith('--')) {
      out._.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    if (eq !== -1) {
      out.flags[a.slice(2, eq)] = a.slice(eq + 1);
      continue;
    }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      out.flags[key] = next;
      i++;
    } else {
      out.flags[key] = true;
    }
  }
  return out;
}

/** Get a string flag or fallback. */
export function flagStr(args: ParsedArgs, name: string, fallback = ''): string {
  const v = args.flags[name];
  return typeof v === 'string' ? v : fallback;
}

/** Get a boolean flag. */
export function flagBool(args: ParsedArgs, name: string): boolean {
  return args.flags[name] === true || args.flags[name] === 'true';
}

/** Prompt for a single line, with an optional default. */
export async function ask(question: string, fallback?: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(fallback ? `${question} [${fallback}]: ` : `${question}: `);
    return answer.trim() || fallback || '';
  } finally {
    rl.close();
  }
}

/**
 * Prompt for a secret (e.g. a signing-key passphrase) **without echoing** it to the terminal.
 * Falls back to a normal echoed read when stdin isn't a TTY (piped / CI input), where masking is moot.
 */
export async function askSecret(question: string): Promise<string> {
  if (!process.stdin.isTTY) return ask(question);
  const state = { muted: false };
  const muted = new Writable({
    write(chunk, _enc, cb) {
      if (!state.muted) process.stdout.write(chunk as Buffer);
      cb();
    },
  });
  const rl = readline.createInterface({ input: process.stdin, output: muted, terminal: true });
  process.stdout.write(`${question}: `);
  state.muted = true; // suppress echo of the typed secret
  try {
    return (await rl.question('')).trim();
  } finally {
    state.muted = false;
    process.stdout.write('\n');
    rl.close();
  }
}

/** Prompt yes/no. */
export async function askYesNo(question: string, defaultYes = false): Promise<boolean> {
  const a = (await ask(`${question} (y/n)`, defaultYes ? 'y' : 'n')).toLowerCase();
  return a.startsWith('y');
}

/** Prompt for multi-line text (release notes); end input with a single "." on its own line. */
export async function askMultiline(question: string): Promise<string> {
  console.log(`${question} (end with a single "." on its own line):`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const lines: string[] = [];
  try {
    for (;;) {
      const line = await rl.question('');
      if (line.trim() === '.') break;
      lines.push(line);
    }
  } finally {
    rl.close();
  }
  return lines.join('\n').trim();
}

/**
 * Refuse to send admin credentials over plaintext `http://` to a non-local host. Localhost is
 * allowed (dev), and `--allow-insecure` is an explicit escape hatch for trusted private networks.
 * @throws if the server URL is invalid or is insecure and not exempted
 */
export function assertSecureServer(server: string, allowInsecure: boolean): void {
  let u: URL;
  try {
    u = new URL(server);
  } catch {
    throw new Error(`invalid --server URL: ${server}`);
  }
  const host = u.hostname.replace(/^\[|\]$/g, ''); // URL.hostname wraps IPv6 in brackets ([::1])
  const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  if (u.protocol === 'http:' && !isLocal && !allowInsecure) {
    throw new Error(
      `refusing to send admin credentials over plaintext http:// to ${u.hostname} — use https:// (or --allow-insecure on a trusted private network).`,
    );
  }
}

/**
 * Resolve the backend base URL + admin token from flags or env. The admin token is the CLI's
 * publish credential (the trust root) — there is **no default**; it must come from `--admin-token`
 * or `OTA_ADMIN_TOKEN`, and plaintext `http://` to a remote host is refused. Only call this for
 * commands that actually contact the backend (offline `keygen` / `--no-upload` never do).
 * @throws if no admin token is set, or the server is insecure (see {@link assertSecureServer})
 */
export function resolveServer(args: ParsedArgs): { server: string; adminToken: string } {
  const server = flagStr(args, 'server', process.env.OTA_SERVER ?? 'http://localhost:4455');
  const adminToken = flagStr(args, 'admin-token') || process.env.OTA_ADMIN_TOKEN || '';
  if (!adminToken) {
    throw new Error('admin token required: pass --admin-token or set OTA_ADMIN_TOKEN (no default — the CLI is the trust root).');
  }
  assertSecureServer(server, flagBool(args, 'allow-insecure'));
  return { server, adminToken };
}

/** POST JSON to an admin endpoint; throws on non-2xx. */
export async function adminPost(server: string, path: string, body: unknown, adminToken: string): Promise<unknown> {
  const res = await fetch(`${server}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ota-admin-token': adminToken },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`POST ${path} → ${res.status}: ${text}`);
  return text ? JSON.parse(text) : {};
}

/** GET JSON from an admin endpoint; throws on non-2xx. */
/**
 * PUT raw bytes to an admin path, with retries.
 *
 * Publishing is many uploads, and a single transient failure part-way through should cost one
 * retry rather than the whole release. Only network faults and 5xx are retried; a 4xx means the
 * bytes are wrong and retrying cannot help.
 *
 * @param server - backend base URL.
 * @param path - admin path.
 * @param bytes - raw body.
 * @param adminToken - admin credential.
 * @param attempts - total tries, including the first.
 * @returns the parsed JSON response.
 */
export async function adminPutBytes(
  server: string,
  path: string,
  bytes: Buffer,
  adminToken: string,
  attempts = 3,
): Promise<unknown> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const res = await fetch(`${server}${path}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/octet-stream', 'x-ota-admin-token': adminToken },
        body: new Uint8Array(bytes),
      });
      const text = await res.text();
      if (res.ok) return text ? JSON.parse(text) : {};
      if (res.status < 500) throw new Error(`PUT ${path} → ${res.status}: ${text}`);
      lastError = new Error(`PUT ${path} → ${res.status}: ${text}`);
    } catch (err) {
      // A 4xx was thrown deliberately above and must not be retried.
      if (err instanceof Error && /→ 4\d\d:/.test(err.message)) throw err;
      lastError = err;
    }
    if (attempt < attempts) await new Promise((r) => setTimeout(r, 500 * attempt));
  }
  throw lastError instanceof Error ? lastError : new Error(`PUT ${path} failed`);
}

/**
 * Human-readable byte size.
 *
 * @param n - byte count.
 * @returns e.g. "9.44 MB".
 */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

export async function adminGet(server: string, path: string, adminToken: string): Promise<unknown> {
  const res = await fetch(`${server}${path}`, { headers: { 'x-ota-admin-token': adminToken } });
  const text = await res.text();
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}: ${text}`);
  return text ? JSON.parse(text) : {};
}

/** Recursively list files under a dir (returns absolute paths). */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

/** Read a bundle directory into archive files with POSIX-style relative paths. */
export function readBundleDir(dir: string): ArchiveFile[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`bundle dir not found: ${dir}`);
  return walk(dir).map((abs) => ({
    path: relative(dir, abs).split(sep).join('/'),
    data: readFileSync(abs),
  }));
}

/** Build-output / tooling dirs excluded from the native fingerprint (non-deterministic noise). */
const NATIVE_FINGERPRINT_IGNORE = new Set(['build', '.gradle', '.cxx', 'Pods', 'DerivedData', 'node_modules', '.idea']);

/** Recursively list files under a native dir, skipping build-output / tooling subdirs. */
function walkNative(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!NATIVE_FINGERPRINT_IGNORE.has(entry.name)) out.push(...walkNative(join(dir, entry.name)));
    } else if (entry.isFile()) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

/**
 * Content-hash a native source tree: sha256 of each file's **bytes** (keyed by relative path),
 * sorted then hashed together. Build-output/tooling dirs are excluded for determinism. Unlike a
 * path+size hash, this flips when native source actually changes — the runtimeVersion gate depends
 * on it, so a same-size edit must not slip through.
 */
function hashNativeDir(dir: string): string {
  if (!existsSync(dir)) return 'absent';
  const entries = walkNative(dir)
    .map((abs) => {
      const rel = relative(dir, abs).split(sep).join('/');
      return `${rel}:${createHash('sha256').update(readFileSync(abs)).digest('hex')}`;
    })
    .sort();
  return createHash('sha256').update(entries.join('\n')).digest('hex').slice(0, 16);
}

/**
 * Compute a project's runtimeVersion from its native inputs: all dependencies + RN version +
 * Hermes version + **content-hashed** native trees ({@link hashNativeDir}). Conservative by
 * design — any dependency change flips the runtimeVersion (safe over churny). A future refinement
 * is a curated native-dependency allowlist so JS-only bumps don't churn the gate.
 * @param projectPath path to the React Native app
 * @returns the runtimeVersion string
 */
export function fingerprintProject(projectPath: string): { runtimeVersion: string; inputs: FingerprintInputs } {
  const pkgPath = join(projectPath, 'package.json');
  if (!existsSync(pkgPath)) throw new Error(`no package.json at ${projectPath}`);
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { dependencies?: Record<string, string> };
  const deps = pkg.dependencies ?? {};
  const nativeDependencies = Object.entries(deps).map(([n, v]) => `${n}@${v}`);

  const rnPkgPath = join(projectPath, 'node_modules', 'react-native', 'package.json');
  const reactNativeVersion = existsSync(rnPkgPath)
    ? (JSON.parse(readFileSync(rnPkgPath, 'utf8')) as { version: string }).version
    : (deps['react-native'] ?? 'unknown');

  const hermesVersionPath = join(projectPath, 'node_modules', 'react-native', 'sdks', '.hermesversion');
  const hermesVersion = existsSync(hermesVersionPath) ? readFileSync(hermesVersionPath, 'utf8').trim() : 'bundled';

  const inputs: FingerprintInputs = {
    nativeDependencies,
    nativeDirHashes: { android: hashNativeDir(join(projectPath, 'android')), ios: hashNativeDir(join(projectPath, 'ios')) },
    hermesVersion,
    reactNativeVersion,
  };
  return { runtimeVersion: computeRuntimeVersion(inputs), inputs };
}

/** Flags every command that talks to the backend accepts. */
const SERVER_FLAGS = ['server', 'admin-token', 'allow-insecure'];

/**
 * Accepted flags per command. An unknown flag is a hard error rather than a no-op: `rollout
 * --rollout 50` would otherwise ramp to 100%, because `--pct` defaults to 100 and the typo is
 * never read.
 */
const KNOWN_FLAGS: Record<string, string[]> = {
  keygen: ['out', 'key-id', 'passphrase', 'no-encrypt', 'content-key-only', 'force', 'register', 'interactive', ...SERVER_FLAGS],
  'register-key': ['key-id', 'pub', 'key-file', ...SERVER_FLAGS],
  fingerprint: ['project'],
  bundle: ['project', 'platform', 'out', 'entry', 'dev', 'hermes'],
  publish: [
    'bundle-dir',
    'app-id',
    'platform',
    'channel',
    'runtime-version',
    'bundle-version',
    'mandatory',
    'target-app-versions',
    'rollout',
    'release-note',
    'bundle-id',
    'key',
    'key-id',
    'passphrase',
    'verify-pub',
    'no-encrypt',
    'content-key',
    'compression-level',
    'no-upload',
    'project',
    'interactive',
    ...SERVER_FLAGS,
  ],
  list: [...SERVER_FLAGS],
  rollout: ['bundle-id', 'pct', ...SERVER_FLAGS],
  pause: ['bundle-id', 'resume', ...SERVER_FLAGS],
  rollback: ['bundle-id', ...SERVER_FLAGS],
  'native-policy': ['channel', 'min', 'severity', 'store-url', ...SERVER_FLAGS],
  dashboard: ['config', 'port', 'no-open'],
};

/**
 * Confusions an edit-distance guess will not catch. `publish` sets the initial percentage with
 * `--rollout`; `rollout` changes it later with `--pct`.
 */
const FLAG_HINTS: Record<string, Record<string, string>> = {
  rollout: { rollout: 'pct', percent: 'pct', percentage: 'pct' },
  publish: { pct: 'rollout' },
};

/** Levenshtein distance, used only to suggest a flag the user probably meant. */
function editDistance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
    }
  }
  return d[a.length]![b.length]!;
}

/**
 * Refuse a flag the command does not accept, naming the closest one it does.
 *
 * @param command - the subcommand being run; an unknown one is left alone.
 * @param args - the parsed argv.
 * @throws if any flag is not in that command's accepted set.
 */
export function assertKnownFlags(command: string, args: ParsedArgs): void {
  const known = KNOWN_FLAGS[command];
  if (!known) return;
  const unknown = Object.keys(args.flags).filter((f) => !known.includes(f));
  if (unknown.length === 0) return;
  const lines = unknown.map((flag) => {
    const hinted = FLAG_HINTS[command]?.[flag];
    const [closest] = known
      .map((k) => ({ k, d: editDistance(flag, k) }))
      .sort((x, y) => x.d - y.d)
      .filter((c) => c.d <= 4);
    const suggestion = hinted ?? closest?.k;
    return `  --${flag}${suggestion ? `   (did you mean --${suggestion}?)` : ''}`;
  });
  throw new Error(
    `unknown flag${unknown.length > 1 ? 's' : ''} for \`${command}\`:\n${lines.join('\n')}\n\n` +
      `  accepted: ${known.map((k) => `--${k}`).join(' ')}`,
  );
}
