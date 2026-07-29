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
